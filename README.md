# OmniTools

OmniTools 是一个基于 React/Vite 的费用报销表单应用，支持生成报销模板、附件展示、合并 PDF 以及本地浏览器数据库保存。

## 功能亮点

- 填写报销基本信息与明细
- 支持图片和 PDF 附件
- 生成可下载的合并 PDF
- 打印报销单
- 保存报销数据到浏览器本地 IndexedDB
- 可部署到 Nginx，并支持可选 SSL/HTTPS

## 安装与部署

### 1. 环境要求

- Ubuntu 24.04 / Debian 13 兼容
- Root 用户或 `sudo` 权限
- 域名已解析到当前服务器（启用 HTTPS 时）

### 2. 一键安装

把仓库克隆到服务器后，在项目根目录下运行：

```bash
sudo bash install.sh
```

该脚本将执行：

1. 检查当前目录是否包含 `package.json`
2. 安装 Node.js 20.x（如果本机版本不足）
3. 安装 `npm`
4. 安装 `nginx`
5. 安装项目依赖并构建前端
6. 配置 Nginx 站点并启用

### 3. 启用 HTTPS

如果希望自动申请并启用 Let's Encrypt 证书，请设置 `DOMAIN` 和 `EMAIL` 环境变量：

```bash
sudo DOMAIN=example.com EMAIL=you@example.com bash install.sh
```

如果 `DOMAIN` 未设置，脚本仍会正常部署 HTTP 服务。

### 4. 手动部署说明

如果你不使用 `install.sh`，也可以手动部署：

```bash
npm install
npm run build
```

然后将生成的 `dist/` 目录作为静态站点部署到 Nginx 或其他 Web 服务器。

## 运行与访问

- HTTP 访问：`http://<server-ip>/`
- HTTPS 访问：`https://<domain>/`（当启用 SSL 时）

## 更新部署

后续更新时，可在项目目录内执行：

```bash
sudo git pull
sudo npm ci
sudo npm run build
sudo systemctl reload nginx
```

## 浏览器数据库

当前应用支持将报销数据保存到浏览器本地数据库（IndexedDB）。

保存功能在确认页面中可见，保存后数据将存储在用户浏览器中。

## 后台管理

应用包含一个后台查看页面，用于查看已保存的报销记录。

- 点击顶部「查看后台」按钮
- 输入密码：`admin123`
- 可以查看所有已保存的报销单及明细

## 贡献与修改

你可以直接修改项目源代码，然后重新运行构建与部署流程。
