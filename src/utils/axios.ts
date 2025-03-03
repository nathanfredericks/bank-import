import axios, { CreateAxiosDefaults } from "axios";
import env from "./env.js";

const config: CreateAxiosDefaults = {};
if (env.PROXY_SERVER && env.PROXY_USERNAME && env.PROXY_PASSWORD) {
  const url = new URL(env.PROXY_SERVER);
  config.proxy = {
    protocol: url.protocol,
    host: url.host.split(":")[0],
    port: parseInt(url.port),
    auth: {
      username: env.PROXY_USERNAME,
      password: env.PROXY_PASSWORD,
    },
  };
}
const instance = axios.create(config);
export default instance;
