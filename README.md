# Docker Hub Worker Proxy

一个部署在 Cloudflare Workers 上的 Docker Hub Registry V2 反向代理。将自己的 Worker 域名配置为 Docker Engine 的 Registry Mirror 后，仍然可以直接执行：

```bash
docker pull nginx
docker pull alpine
docker pull hello-world
```

不需要在镜像名称前添加代理域名。

## 功能

- 将 Docker Registry V2 请求固定转发至 Docker Hub 官方 Registry。
- 将 Bearer Token 请求转发至 Docker Hub 官方 Token 服务。
- 重写 `WWW-Authenticate` 中的 Token Realm，使 Docker 客户端通过自己的 Worker 域名获取 Token。
- 保留 Docker Hub 返回的外部 Blob/CDN 重定向，让客户端直接下载大型镜像层。
- 支持 `GET` 和 `HEAD`，覆盖普通镜像拉取流程。
- 不需要 VPS、容器、数据库、R2 或第三方运行时依赖。
- 不包含任何个人域名、Cloudflare Account ID、Zone ID、API Token 或账号凭据。

> **注意：这是透明反向代理，不是持久化镜像缓存。** Worker 不保存镜像层；重复拉取仍可能访问 Docker Hub。Docker Hub 的使用限制和 Fair Use Policy 仍然适用。

## 环境要求

- Cloudflare 账户。
- 已添加到 Cloudflare 的域名（Active Zone）。
- Node.js / npm，用于运行测试和 Wrangler。
- Docker Engine 或 Docker Desktop。

## 部署

### 1. Fork 并克隆仓库

```bash
git clone https://github.com/<YOUR_GITHUB_ACCOUNT>/docker-hub-worker-proxy.git
cd docker-hub-worker-proxy
```

### 2. 登录 Cloudflare

```bash
npx wrangler@latest login
```

### 3. 部署 Worker

```bash
npx wrangler@latest deploy
```

仓库中的 `wrangler.toml` 默认设置 `workers_dev = false`，不发布默认的 `workers.dev` 入口，也没有写入任何域名或账户信息。

### 4. 绑定你自己的域名

在 Cloudflare Dashboard 中操作：

1. 打开 **Workers & Pages**。
2. 选择刚部署的 `docker-hub-worker-proxy`。
3. 进入 **Settings → Domains & Routes**。
4. 选择 **Add → Custom Domain**。
5. 输入你自己的域名，例如 `YOUR_SUBDOMAIN.YOUR_DOMAIN`。
6. 确认创建。

该域名必须属于你自己的 Cloudflare Zone。Cloudflare 会自动创建 DNS 记录并处理证书。建议使用专门的子域名，并确保该主机名没有冲突的 DNS 记录。

#### 可选：通过 Wrangler 配置域名

也可以编辑 `wrangler.toml`，取消下面配置的注释，并替换成你自己的域名：

```toml
[[routes]]
pattern = "YOUR_SUBDOMAIN.YOUR_DOMAIN"
custom_domain = true
```

Dashboard 管理和 Wrangler 管理二选一即可。不要把个人域名提交到公开仓库。

## 配置 Docker

将自己的域名作为 Registry Mirror。只填写域名根地址，不要追加 `/v2`、`/token` 或镜像路径。

### Linux Docker Engine

编辑 `/etc/docker/daemon.json`，合并以下配置：

```json
{
  "registry-mirrors": [
    "https://YOUR_SUBDOMAIN.YOUR_DOMAIN"
  ]
}
```

如果文件已经包含其他 Docker 配置，请保留原有配置，只增加 `registry-mirrors` 字段。然后重启 Docker：

```bash
sudo systemctl restart docker
```

Rootless Docker Engine 通常使用 `~/.config/docker/daemon.json`。

### Docker Desktop

打开 **Settings → Docker Engine**，将同一个 `registry-mirrors` 字段合并到现有 JSON，然后选择 **Apply & Restart**。

### 验证

```bash
docker info
```

在 `Registry Mirrors` 下确认你的域名已列出，然后直接拉取普通 Docker Hub 镜像：

```bash
docker pull hello-world
docker pull library/alpine:latest
docker pull nginx:latest
```

不需要修改镜像名称。Docker Engine 的 `registry-mirrors` 配置用于 Docker Hub（`docker.io`）。

## 本地测试

测试使用 Node.js 内置测试运行器，不需要 Wrangler，也不需要连接网络：

```bash
npm test
```

## 支持范围与限制

| 功能 | 状态 |
| --- | --- |
| Docker Hub 镜像拉取 | 支持代理流程 |
| Registry V2 `/v2/` | 支持 |
| Manifest / Blob 请求 | 转发 |
| Bearer Token 鉴权挑战 | 改写为 Worker 域名 |
| Token API | 转发到 `auth.docker.io` |
| 外部 Blob/CDN 重定向 | 原样返回 |
| `GET` / `HEAD` | 支持 |
| 镜像推送及 `POST` / `PUT` / `PATCH` / `DELETE` | 不支持 |
| GHCR、Quay、ECR 等其他 Registry | 不支持 |
| R2 或其他持久化镜像缓存 | 不包含 |
| 绕过 Docker Hub 限流 | 不提供 |

Docker Engine 的 `registry-mirrors` 面向 Docker Hub，并不是所有第三方 Registry 的通用代理配置。

### Buildx / BuildKit

Buildx 可能使用独立的 BuildKit daemon 配置。如果发现 `docker buildx build` 没有使用 Docker Engine 的镜像代理，需要在 BuildKit 配置中单独声明：

```toml
[registry."docker.io"]
  mirrors = ["YOUR_SUBDOMAIN.YOUR_DOMAIN"]
```

具体应用方式请参考 Docker 的 BuildKit Registry 配置文档。

## 安全说明

- 上游地址固定为 Docker Hub Registry 和 Token 服务，不接受用户提供的目标 URL，避免成为任意 URL 代理或 SSRF 入口。
- 仅转发 `GET` / `HEAD`，并且只接受 `/v2`、`/v2/…` 和 `/token` 路径。
- 移除逐跳请求头、Cookie 及常见访客 IP 转发头；保留 Docker 协议所需的 `Authorization`、`Accept`、`Range` 和条件请求头。
- 项目没有内置访问认证。任何能够访问该域名的人都可以使用代理。公开使用前，建议配置 Cloudflare WAF / Rate Limiting 并监控流量。
- 不要向仓库提交私有凭据、账户标识、API Token 或个人域名。
- 本项目不规避 Docker Hub 的服务条款、身份验证要求或 Fair Use Policy。

## 参考资料

- [Docker：Mirror the Docker Hub library](https://docs.docker.com/docker-hub/image-library/mirror/)
- [Docker：Docker daemon configuration](https://docs.docker.com/engine/daemon/)
- [Docker：Configure BuildKit](https://docs.docker.com/build/buildkit/configure/)
- [Cloudflare Workers：Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Workers：Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
