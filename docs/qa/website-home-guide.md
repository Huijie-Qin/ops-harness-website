# 官网首页、实拍截图与指南验收

> 迁移前的历史验收记录，原命令与路径仅用于追溯；当前操作见 [官网 README](../../README.md)。

日期：2026-09-13。环境：macOS、Chrome，官网开发服务 `127.0.0.1:4173`，生产预览临时服务 `127.0.0.1:4174`。

## 本次范围

- 首页增加蓝色光场和旋转点阵 Canvas 动画，可暂停/继续；遵循减少动态效果偏好，并在页面后台或动画离开可见区域时停止刷新。
- 首页及指南共用工具市场、我的技能、我的专家三张真实 JPEG 截图。采集入口、版本与隐私检查要求见 `src/website/README.md`。
- 指南扩展为 10 个章节、5 个可复制示例与 10 个常见问题，增加全文搜索、分组目录、章节链接及问题到操作步骤的跳转。

## 已验证

- `pnpm local:bootstrap` 通过，使用 `.runtime/dsh-home` / `web` 启动真实 DSH Web 后采集截图。
- `pnpm check:website` 通过：Vue 与服务端类型检查，以及 7 项官网测试。新增测试检查三张 JPEG 原始字节、生产 MIME、HEAD、缺失图片和静态路径范围。
- `pnpm website:build` 通过。生产预览的首页、指南、更新页、健康检查、发布 API 和三张截图均返回 HTTP 200；截图字节与源文件一致，类型为 `image/jpeg`。
- Chrome 实际验证首页动效暂停/继续状态、三张截图切换及方向键操作；桌面 1470 px 与手机 390 px 无横向溢出，手机菜单可用 Escape 关闭。
- 实际验证指南搜索、无结果提示、清空、示例复制反馈、问题跳转时清空筛选、搜索后的快速开始链接，以及 `#step-2` 旧链接跳转到模型章节。修复全局滚动留白与章节留白叠加，章节定位在固定导航下方。
- 生产页面实际显示截图，尺寸为 1470 × 746；生产首页、指南 Console 无 warn/error。

本次未发布站点或安装包，未执行全仓测试或重新验收 Desktop 安装升级。减少动态效果的分支与资源清理经代码核对，未修改系统偏好进行模拟。

## 本地验收证据

日志和浏览器截图保留在忽略目录 `.runtime/website-qa/`：

- `website-check-final.log`、`website-build.log`、`production-http.json`。
- `after-home.jpg`、`after-showcase.jpg`、`after-guide.jpg`；手机截图为 `after-home-mobile.jpg`、`after-guide-mobile.jpg`。

验收后关闭临时生产预览服务，保留 `4173` 官网开发服务。实拍用的本地 DSH Web 服务位于 `3081`。
