import scripts from "./scripts/index";
import OSS from "ali-oss";

require("dotenv").config();

let ossClient = null;
const { OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET } = process.env;
if (OSS_ACCESS_KEY_ID && OSS_ACCESS_KEY_SECRET) {
  ossClient = new OSS({
    region: "oss-cn-wulanchabu",
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: "ddc-lntu",
  });
}

(async () => {
  await scripts.reNewClashSub(ossClient);
})();
