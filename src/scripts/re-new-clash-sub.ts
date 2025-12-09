import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { execSync, spawn, ChildProcess } from "child_process";
import { cloneDeep } from "lodash";
import yaml from "js-yaml";
import OSS from "ali-oss";

interface Proxy {
  name: string;
  server: string;
  port: number;
  type: string;
  password: string;
  sni: string;
  "skip-cert-verify": boolean;
}

interface ClashConfig {
  proxies: Proxy[];
  "proxy-groups": {
    name: string;
    type: string;
    proxies: string[];
    [key: string]: any;
  }[];
  rules: string[];
}

interface Hy2ProxyConfig {
  server: string;
  port: number;
  password: string;
  sni?: string;
  insecure: boolean;
  name: string;
}

// 解析 HY2_CONFIG 获取代理配置列表
function parseHy2Config(hy2Config: string): Hy2ProxyConfig[] {
  const regex = /hy2:\/\/([^@]+)@([^:]+):(\d+)\?(?:insecure=(\d))?(?:&sni=([^#\n]+))?#([^#\n]+)/g;
  const matches = [...hy2Config.matchAll(regex)];
  return matches.map((match) => ({
    password: match[1],
    server: match[2],
    port: parseInt(match[3]),
    insecure: match[4] === "1",
    sni: match[5],
    name: match[6],
  }));
}

// 全局变量：当前运行的 hy2 进程和代理端口
let currentHy2Process: ChildProcess | null = null;
const HY2_SOCKS_PORT = 11080;

// 启动 hysteria2 客户端作为 SOCKS5 代理
async function startHy2Proxy(proxy: Hy2ProxyConfig): Promise<boolean> {
  // 先停止之前的进程
  stopHy2Proxy();

  const hy2ConfigContent = {
    server: `${proxy.server}:${proxy.port}`,
    auth: proxy.password,
    tls: {
      sni: proxy.sni || proxy.server,
      insecure: proxy.insecure,
    },
    socks5: {
      listen: `127.0.0.1:${HY2_SOCKS_PORT}`,
    },
  };

  // 写入临时配置文件
  const configPath = "/tmp/hy2-client.yaml";
  writeFileSync(configPath, yaml.dump(hy2ConfigContent));

  return new Promise((resolve) => {
    try {
      // 启动 hysteria2 客户端
      currentHy2Process = spawn("hysteria", ["client", "-c", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let started = false;

      currentHy2Process.stdout?.on("data", (data) => {
        const output = data.toString();
        if (output.includes("server address") || output.includes("SOCKS5")) {
          started = true;
        }
      });

      currentHy2Process.stderr?.on("data", (data) => {
        console.log(`[hy2 stderr] ${data.toString().trim()}`);
      });

      currentHy2Process.on("error", (err) => {
        console.error(`启动 hysteria2 失败: ${err.message}`);
        resolve(false);
      });

      // 等待一段时间让代理启动
      setTimeout(() => {
        if (currentHy2Process && !currentHy2Process.killed) {
          // 测试代理是否可用
          try {
            execSync(`curl -s --socks5 127.0.0.1:${HY2_SOCKS_PORT} --connect-timeout 5 https://www.google.com -o /dev/null`, {
              timeout: 10000,
            });
            console.log(`代理 ${proxy.name} 启动成功`);
            resolve(true);
          } catch {
            console.log(`代理 ${proxy.name} 连接测试失败`);
            resolve(false);
          }
        } else {
          resolve(false);
        }
      }, 3000);
    } catch (err) {
      console.error(`启动 hysteria2 异常: ${err}`);
      resolve(false);
    }
  });
}

// 停止 hysteria2 客户端
function stopHy2Proxy() {
  if (currentHy2Process && !currentHy2Process.killed) {
    currentHy2Process.kill();
    currentHy2Process = null;
  }
}

// 使用代理请求数据
function fetchWithSocks5Proxy(url: string): string | null {
  try {
    const result = execSync(
      `curl -s --socks5 127.0.0.1:${HY2_SOCKS_PORT} -X GET "${url}" -H "User-Agent: clash-verge/v2.4.2" -H "Accept-Encoding: deflate, gzip" --compressed --connect-timeout 15 --max-time 30`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );
    // 检查是否返回了 HTML（Cloudflare 拦截页面）
    if (result.includes("<!DOCTYPE html>") || result.includes("<html")) {
      console.log("返回了 HTML 页面，可能被拦截");
      return null;
    }
    return result;
  } catch (err) {
    console.error("通过代理请求失败:", err);
    return null;
  }
}

// 带代理重试的请求函数
async function fetchSubDataWithHy2Proxy(url: string, hy2Proxies: Hy2ProxyConfig[]): Promise<string | null> {
  for (const proxy of hy2Proxies) {
    console.log(`尝试使用代理: ${proxy.name} (${proxy.server}:${proxy.port})`);
    const started = await startHy2Proxy(proxy);
    if (!started) {
      console.log(`代理 ${proxy.name} 启动失败，尝试下一个`);
      continue;
    }

    const result = fetchWithSocks5Proxy(url);
    if (result) {
      console.log(`通过代理 ${proxy.name} 请求成功`);
      return result;
    }
    console.log(`通过代理 ${proxy.name} 请求失败，尝试下一个`);
  }

  stopHy2Proxy();
  return null;
}

async function fetchSubData(url: string, hy2Proxies?: Hy2ProxyConfig[]) {
  // 首先尝试直接请求
  try {
    // Windows CMD 中 & 是命令分隔符，需要用双引号包裹 URL
    const result = execSync(
      `curl -s -X GET "${url}" -H "User-Agent: clash-verge/v2.4.2" -H "Accept-Encoding: deflate, gzip" --compressed --connect-timeout 10 --max-time 20`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    // 检查是否返回了 HTML（Cloudflare 拦截页面）
    if (result.includes("<!DOCTYPE html>") || result.includes("<html")) {
      console.log("直接请求返回了 HTML 页面，可能被 Cloudflare 拦截");
      throw new Error("Cloudflare blocked");
    }
    return result;
  } catch (curlError) {
    console.warn('直接 curl 请求失败，尝试使用 hy2 代理...');
  }

  // 如果直接请求失败，尝试使用 hy2 代理
  if (hy2Proxies && hy2Proxies.length > 0) {
    const result = await fetchSubDataWithHy2Proxy(url, hy2Proxies);
    if (result) {
      return result;
    }
  }

  // fallback 到 fetch
  const headers = {
    'User-Agent': 'clash-verge/v2.4.2',
    'Accept-Encoding': 'deflate, gzip'
  };

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const text = await response.text();
    // 检查是否返回了 HTML
    if (text.includes("<!DOCTYPE html>") || text.includes("<html")) {
      console.log("fetch 返回了 HTML 页面，可能被拦截");
      return undefined;
    }

    return text;
  } catch (error) {
    console.error('Fetch error:', error);
  }
}


export async function reNewClashSub(ossClient: OSS | null) {
  const { SUB_URL, HY2_CONFIG, NEED_OUTPUT_FILE, NEED_ONLY_HY2, HY2_SUB_URL, CLASH_ADDITIONAL_RULES } =
    process.env;

  // 预先解析 hy2 代理配置，用于后续请求时作为备用代理
  const hy2Proxies = HY2_CONFIG ? parseHy2Config(HY2_CONFIG) : [];
  if (hy2Proxies.length > 0) {
    console.log(`已解析 ${hy2Proxies.length} 个 hy2 代理配置，将在需要时使用`);
  }

  if (SUB_URL) {
    console.log("获取 clash 订阅中...");
    const yamlContent = await fetchSubData(SUB_URL, hy2Proxies);

    if (!yamlContent) {
      console.log("未获取到订阅")
      return;
    }

    console.log("获取 clash 订阅成功, 开始处理...");

    const content = yaml.load(yamlContent) as ClashConfig;
    const onlyHy2Content = NEED_ONLY_HY2 ? cloneDeep(content) : null;

    if (CLASH_ADDITIONAL_RULES) {
      try {
        content.rules.unshift(...JSON.parse(CLASH_ADDITIONAL_RULES));
        console.log("CLASH_ADDITIONAL_RULES 添加成功:", CLASH_ADDITIONAL_RULES);
      } catch (error) {
        console.error("CLASH_ADDITIONAL_RULES 格式错误", error);
      }
    }

    // 如果有 hy2 配置 添加到 proxies 中
    if (HY2_CONFIG || HY2_SUB_URL) {
      let hy2ConfigList: Proxy[] = [];

      if (HY2_CONFIG) {
        // 使用正则表达式匹配字符串中的信息
        const regex =
          /hy2:\/\/([^@]+)@([^:]+):(\d+)\?(?:insecure=(\d))?(?:&sni=([^#\n]+))?#([^#\n]+)/g;
        const matches = [...HY2_CONFIG.matchAll(regex)];

        // 将匹配的信息转换为对象数组
        hy2ConfigList = matches.map((match) => ({
          name: match[6],
          server: match[2],
          port: parseInt(match[3]),
          type: "hysteria2",
          password: match[1],
          sni: match[5],
          "skip-cert-verify": match[4] === "0",
        }));
      }

      if (HY2_SUB_URL) {
        console.log("获取 hy2 订阅中...");
        const hy2SubYamlContent = await fetchSubData(HY2_SUB_URL, hy2Proxies);


        if (!hy2SubYamlContent) {
          console.log("未获取到 hy2 订阅")
          stopHy2Proxy();
          return;
        }

        console.log("获取 hy2 订阅成功, 开始处理...");
        const hy2SubContent = yaml.load(hy2SubYamlContent) as ClashConfig;
        hy2ConfigList = hy2ConfigList.concat(hy2SubContent.proxies);
      }

      // 去重
      content.proxies = content.proxies.filter(
        (proxy) => !hy2ConfigList.some((hy2Proxy) => hy2Proxy.name === proxy.name)
      )

      // 加入代理配置
      content.proxies = hy2ConfigList.concat(content.proxies);
      onlyHy2Content && (onlyHy2Content.proxies = hy2ConfigList);


      // 加入规则分组
      const groupsName = content["proxy-groups"].map(({ name }) => name);
      content["proxy-groups"].forEach(({ proxies }, index) => {
        if (proxies.length <= 3) {
          return;
        }

        // 将游戏节点和实验移动到靠前
        const gameGroup = proxies.filter((name) => name.includes("G") || name.includes("E") && name !== "DIRECT");
        const otherGroup = proxies.filter((name) => !(name.includes("G") || name.includes("E") && name !== "DIRECT"));
        proxies = otherGroup;

        let insertPlace = 0;
        let checkNameTemp = proxies[insertPlace];
        while (groupsName.includes(checkNameTemp)) {
          insertPlace++;
          checkNameTemp = proxies[insertPlace];
        }
        proxies.splice(
          insertPlace,
          insertPlace,
          ...hy2ConfigList.map(({ name }) => name),
          ...gameGroup
        );

        // 去重
        proxies = [...new Set(proxies)];

        content["proxy-groups"][index].proxies = proxies;
      });
      // 处理仅 hy2 的规则组
      onlyHy2Content &&
        onlyHy2Content["proxy-groups"].forEach((group) => {
          if (group.proxies.length <= 3) {
            return;
          }
          let insertPlace = 0;
          let checkNameTemp = group.proxies[insertPlace];
          const groupNames = [];
          while (groupsName.includes(checkNameTemp)) {
            groupNames.push(checkNameTemp);
            insertPlace++;
            checkNameTemp = group.proxies[insertPlace];
          }
          group.proxies = groupNames.concat(
            hy2ConfigList.map(({ name }) => name)
          );
        });
    } else {
      console.log(
        "HY2_CONFIG is not defined, will not add hy2 proxies to clash config"
      );
    }

    const yamlFile = yaml.dump(content);
    const yamlFileOnlyHy2 = onlyHy2Content ? yaml.dump(onlyHy2Content) : null;
    if (NEED_OUTPUT_FILE || ossClient) {
      if (!existsSync("dist")) {
        mkdirSync("dist");
      }
      // writeFileSync("dist/config.json", JSON.stringify(content, null, 2));
      writeFileSync("dist/config.yaml", yamlFile);
      yamlFileOnlyHy2 && writeFileSync("dist/hy2.yaml", yamlFileOnlyHy2);
    }

    if (ossClient) {
      try {
        const uploadResult = await ossClient.put(
          "all.yaml",
          "dist/config.yaml"
        );
        console.log("上传 OSS 成功:", uploadResult.name);
        if (NEED_ONLY_HY2) {
          const uploadResult = await ossClient.put("hy2.yaml", "dist/hy2.yaml");
          console.log("上传 OSS 成功:", uploadResult.name);
        }
      } catch (error) {
        console.error("上传到 OSS 失败:", error);
      }
    } else {
      console.log("ossClient is not defined, skipping upload to OSS");
    }

    // 删除 temp 文件
    if (!NEED_OUTPUT_FILE) {
      try {
        rmSync("dist", { recursive: true });
      } catch {
        //
      }
    }

    // 清理 hy2 代理进程
    stopHy2Proxy();

    console.log("clash 订阅任务完成");
  } else {
    console.warn("SUB_URL is not defined, skipping reNewClashSub");
  }
}
