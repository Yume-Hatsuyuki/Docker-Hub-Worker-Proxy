# Docker Hub Worker Proxy

一个部署在 Cloudflare Workers 上的 Docker Hub Registry V2 反向代理。将自己的 Worker 自定义域名配置为 Docker Engine 的 Registry Mirror 后，仍然可以直接执行：

```bash
docker pull nginx
docker pull alpine
docker pull hello-world
```

## 功能

- 将 Docker Registry V2 请求固定转发至 Docker Hub 官方 Registry。
- 将 Bearer Token 请求转发至 Docker Hub 官方 Token 服务。
- 可选使用部署者自己的 Docker Hub 用户名和 Personal Access Token（PAT）获取已认证的 Bearer Token；不配置时保持匿名模式。
- Token scope 限制为 Docker Hub 仓库的 `pull`，拒绝通过代理申请 `push` 等写权限。
- 重写 `WWW-Authenticate` 中的 Token Realm，使 Docker 客户端通过自己的 Worker 域名获取 Token。
- 保留 Docker Hub 返回的外部 Blob/CDN 重定向，让客户端直接下载大型镜像层。
- 支持 `GET` 和 `HEAD`，覆盖普通镜像拉取流程。
- 不需要 VPS、容器、数据库、R2 或第三方运行时依赖。
- 不包含任何个人域名、Cloudflare Account ID、Zone ID、API Token 或账号凭据。

> **注意：这是透明反向代理，不是持久化镜像缓存。** Worker 不保存镜像层；重复拉取仍可能访问 Docker Hub。Docker Hub 的使用限制和 Fair Use Policy 仍然适用。

## 环境要求

- Cloudflare 账户。
- 一个已添加到 Cloudflare 且状态为 Active 的域名（Zone）。
- 用于 Docker 客户端的 Docker Engine 或 Docker Desktop。
- 可选：Docker Hub 账号和 `Repo Public Read-only` PAT。匿名模式不需要注册 Docker Hub。

## 使用 Cloudflare Dashboard 部署（全程网页）

本节是推荐部署方式。**无需下载项目、安装 Node.js、运行命令或使用 Wrangler。**

### 1. 在 GitHub 网页打开 Worker 源码

1. 在浏览器中打开本项目的 GitHub 仓库。
2. 进入 `src/index.js`。
3. 点击文件右上方的 **Raw**。
4. 在 Raw 页面全选源码并复制。

只需要复制 `src/index.js` 的完整内容。`wrangler.toml`、测试文件和 README 都不需要粘贴到 Cloudflare 编辑器。

### 2. 在 Cloudflare 创建 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) 并选择自己的账户。
2. 打开 **Workers & Pages**。
3. 点击 **Create application**（部分界面显示 **Create**）。
4. 选择 **Create Worker** 或 **Hello World** 模板。
5. 将 Worker 命名为 `docker-hub-worker-proxy`，然后点击 **Deploy**。
6. 创建完成后，进入该 Worker 的详情页，点击 **Edit code**。

Cloudflare 不同界面版本的按钮文字可能略有差异；目标是先创建一个普通 JavaScript Worker，再打开在线代码编辑器。

### 3. 将项目源码粘贴到在线编辑器

1. 在 Cloudflare 在线代码编辑器中打开默认的 Worker 脚本文件（通常是 `worker.js` 或 `index.js`）。
2. 全选默认示例代码并删除。
3. 粘贴刚才从 GitHub `src/index.js` 的 Raw 页面复制的完整源码。
4. 点击 **Deploy**（有些界面会先显示 **Save and Deploy**）。
5. 等待 Dashboard 显示部署成功。

不要只粘贴其中一个函数或片段，必须替换为 `src/index.js` 的完整内容。这个 Worker 是单文件实现，不需要添加 npm 套件或其他依赖。

### 4. （可选）设置 Docker Hub 账号凭据

默认匿名模式即可运行，不需要 Docker Hub 账号。如果 Docker Hub 对 Worker 的匿名出口返回 `429 TOOMANYREQUESTS`，可以选择使用部署者自己的账号配额。

#### 4.1 创建 Docker Hub PAT

1. 登录 [Docker Hub](https://hub.docker.com/)。
2. 打开账户设置中的 **Personal access tokens**。
3. 创建一个新 Token。
4. Repository permissions 必须选择 **Repo Public Read-only**。
5. 复制新生成的 PAT。Docker Hub 通常只在创建时显示完整 Token，请妥善保存。

不要使用 Docker Hub 登录密码。不要选择 `Repo Read-only`、Read & Write 或 Delete 权限；`Repo Read-only` 可能允许读取账号有权访问的私有仓库。

官方说明：[Docker Hub Access Token permissions](https://docs.docker.com/security/access-tokens/reference/)。

#### 4.2 在 Cloudflare 添加两个 Secret

1. 回到 Cloudflare Dashboard → **Workers & Pages**。
2. 选择 `docker-hub-worker-proxy`。
3. 打开 **Settings**。
4. 找到 **Variables and Secrets**，点击 **Add**。
5. 类型选择 **Secret**，变量名称填写 `DOCKERHUB_USERNAME`，值填写 Docker Hub 用户名。
6. 点击 **Add variable**，再添加第二个 Secret：
   - 名称：`DOCKERHUB_TOKEN`
   - 值：刚才创建的 PAT
7. 点击 **Deploy**，使新 Secret 生效。

务必选择 **Secret**，不要选择普通 Text/Variable。Secret 值保存后不会再以明文显示。

如果不配置这两个 Secret，Worker 使用匿名模式；如果只配置其中一个，Worker 不会使用不完整的凭据。配置完成后，Docker 客户端仍然不需要执行 `docker login`，也不需要修改镜像名称。

**配额与安全：** 配置的账号配额由所有使用该 Worker 的客户端共享，不是每个客户端各自获得一份配额。不要把配置了个人 PAT 的 Worker 无保护地公开；任何能访问域名的人都可能消耗你的账号配额。请务必使用 `Repo Public Read-only` PAT，并考虑通过 Cloudflare WAF / IP 规则限制访问及设置速率限制。PAT 到期或撤销后，需要在 Dashboard 中更新对应 Secret 并重新部署。

### 5. 绑定自己的域名

1. 确认目标域名已经添加到 Cloudflare，且 Zone 状态为 **Active**。
2. 在 Workers & Pages 中打开 `docker-hub-worker-proxy`。
3. 打开 **Settings → Domains & Routes**。新版 Dashboard 也可能提供独立的 **Domains** 标签页。
4. 点击 **Add → Custom Domain**。
5. 输入自己准备的子域名，例如 `docker.example.com`。
6. 点击 **Add Custom Domain** 并等待 Cloudflare 创建 DNS 记录和证书。

请将 `docker.example.com` 替换成你自己的域名。不要使用项目维护者的域名，也不要把自己的域名提交到公开仓库。

**注意：** 该子域名必须属于自己的 Active Cloudflare Zone。若目标主机名已经存在 CNAME 记录，先在 DNS 页面处理冲突，再创建 Custom Domain。Cloudflare 会为 Custom Domain 自动建立所需 DNS 记录并签发证书。

#### 5.1 禁用默认 workers.dev 地址（建议）

创建 Worker 时，Cloudflare 可能同时为它启用 `workers.dev` 访问地址。如果你只希望使用自己绑定的域名：

1. 打开 Worker 的 **Settings → Domains & Routes**（新版界面也可能在 **Domains** 标签页）。
2. 找到 `workers.dev`。
3. 点击 **Disable** 并确认。

这不会影响已经绑定的 Custom Domain。Cloudflare 的 Preview / Version URL 是独立设置；如果也不希望公开预览地址，请另外检查并关闭相应预览功能。

### 6. 在浏览器验证 Worker

假设你的自定义域名是 `docker.example.com`：

1. 打开 `https://docker.example.com/`，预期显示：

   ```text
   Docker Hub Worker Proxy is running.
   ```

   HTTP 状态应为 `200`。

2. 打开 `https://docker.example.com/v2/`。预期 HTTP 状态为 `401`，并带有 `WWW-Authenticate` 响应头，其中 `realm` 应指向：

   ```text
   https://docker.example.com/token
   ```

   **`/v2/` 返回 401 是正常的**，表示 Docker Registry 正在要求客户端获取 Bearer Token；不代表 Worker 部署失败。可在浏览器开发者工具的 Network → Response Headers 中检查 `WWW-Authenticate`。

### 7. 在 Docker Desktop 配置 Registry Mirror

Cloudflare 部署完成后，在 Docker Desktop 中：

1. 打开 **Settings → Docker Engine**。
2. 在现有 JSON 配置中添加 `registry-mirrors`：

   ```json
   {
     "registry-mirrors": [
       "https://docker.example.com"
     ]
   }
   ```

3. 如果原来已有其他 Docker Engine 配置，请合并字段，不要覆盖原有设置。
4. 点击 **Apply & Restart**。
5. 重启完成后测试：

   ```bash
   docker pull hello-world
   docker pull alpine:latest
   docker pull nginx:latest
   ```

将示例域名替换成自己绑定的域名。镜像源只填写 `https://你的域名`，不要追加 `/v2`、`/token` 或镜像路径。

Linux Docker Engine 用户可将相同的 `registry-mirrors` 字段合并到 `/etc/docker/daemon.json`，然后重启 Docker 服务；此步骤属于 Docker 主机配置，不属于 Cloudflare Worker 部署。

### 8. 在 Cloudflare 网页查看日志

如果 Docker 拉取失败，可在 Cloudflare Dashboard 中打开 **Workers & Pages → docker-hub-worker-proxy → Logs / Observability**，查看实时请求与异常。Dashboard 的日志菜单名称会随界面版本变化。

常见现象：

| 现象 | 含义 / 检查方向 |
| --- | --- |
| `/` 返回 200 | Worker 已经响应 |
| `/v2/` 返回 401，Realm 是自己的域名 | Registry 鉴权挑战改写正常 |
| `/token` 返回 200 | Token 服务代理成功 |
| Manifest 返回 429 `TOOMANYREQUESTS` | Docker Hub 上游限流；检查是否配置 PAT、PAT 权限和账号配额 |
| Manifest 返回 401 | 检查 Token 请求、Secret 是否配置完整以及响应中的鉴权信息 |
| Manifest 返回 200，但镜像层下载失败 | 检查 Blob/CDN 重定向和客户端网络 |

## Docker 客户端配置补充

Docker Engine 的 `registry-mirrors` 面向 Docker Hub（`docker.io`），不是所有第三方 Registry 的通用代理配置。

### Buildx / BuildKit

Buildx 可能使用独立的 BuildKit daemon 配置。如果 `docker buildx build` 没有使用 Docker Engine 的镜像代理，需要在 BuildKit 配置中单独声明：

```toml
[registry."docker.io"]
  mirrors = ["docker.example.com"]
```

具体应用方式请参考 [Docker BuildKit Registry 配置](https://docs.docker.com/build/buildkit/configure/)。

## 支持范围与限制

| 功能 | 状态 |
| --- | --- |
| Docker Hub 镜像拉取 | 支持代理流程 |
| Registry V2 `/v2/` | 支持 |
| Manifest / Blob 请求 | 转发 |
| Bearer Token 鉴权挑战 | 改写为 Worker 域名 |
| Token API | 转发到 `auth.docker.io` |
| 可选上游账号认证 | 通过 Worker Secrets 注入 `Repo Public Read-only` PAT |
| Token 写权限 scope | 拒绝 `push` 等非 pull scope |
| 外部 Blob/CDN 重定向 | 原样返回 |
| `GET` / `HEAD` | 支持 |
| 镜像推送及 `POST` / `PUT` / `PATCH` / `DELETE` | 不支持 |
| GHCR、Quay、ECR 等其他 Registry | 不支持 |
| R2 或其他持久化镜像缓存 | 不包含 |
| 绕过 Docker Hub 限流 | 不提供 |

## 安全说明

- 上游地址固定为 Docker Hub Registry 和 Token 服务，不接受用户提供的目标 URL，避免成为任意 URL 代理或 SSRF 入口。
- 仅转发 `GET` / `HEAD`，并且只接受 `/v2`、`/v2/…` 和 `/token` 路径。
- 移除逐跳请求头、Cookie 及常见访客 IP 转发头；保留 Docker 协议所需的 `Authorization`、`Accept`、`Range` 和条件请求头。
- 项目没有内置客户端访问认证。任何能够访问该域名的人都可以使用代理。配置上游账号后，这些访客会共享部署者的 Docker Hub 配额；公开使用前，建议配置 Cloudflare WAF / IP 访问规则及 Rate Limiting 并监控流量。
- PAT 必须选择 `Repo Public Read-only`。不要将可读取私有仓库的 PAT 用于公开代理。
- 不要向仓库提交私有凭据、账户标识、API Token 或个人域名。
- 本项目不规避 Docker Hub 的服务条款、身份验证要求或 Fair Use Policy。

## 参考资料

- [Cloudflare Workers：Dashboard 入门](https://developers.cloudflare.com/workers/get-started/dashboard/)
- [Cloudflare Workers：Secrets（Dashboard 配置）](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers：Custom Domains（Dashboard 配置）](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Workers：workers.dev 管理](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Docker：Mirror the Docker Hub library](https://docs.docker.com/docker-hub/image-library/mirror/)
- [Docker：Docker daemon configuration](https://docs.docker.com/engine/daemon/)
- [Docker：Configure BuildKit](https://docs.docker.com/build/buildkit/configure/)
- [Docker Hub：Access token reference](https://docs.docker.com/security/access-tokens/reference/)
