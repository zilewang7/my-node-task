import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
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

export async function reNewClashSub(ossClient: OSS | null) {
  const { SUB_URL, HY2_CONFIG, NEED_OUTPUT_FILE, NEED_ONLY_HY2, HY2_SUB_URL, CLASH_ADDITIONAL_RULES } =
    process.env;

  if (SUB_URL) {
    console.log("获取 clash 订阅中...");
    const filed = await fetch(SUB_URL);
    const yamlContent = await filed.text();
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
        const hy2SubFile = await fetch(HY2_SUB_URL);
        const hy2SubYamlContent = await hy2SubFile.text();
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

    console.log("clash 订阅任务完成");
  } else {
    console.warn("SUB_URL is not defined, skipping reNewClashSub");
  }
}
