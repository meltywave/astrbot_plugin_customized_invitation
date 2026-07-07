1. 修复从 QQ 中 Bot 提供的链接进入编辑器后，点击保存提示 `Failed to fetch` 的问题。
2. 修复从 AstrBot 插件页直接打开编辑器后，点击保存提示 `Failed to fetch` 的问题。
3. 编辑器模板列表和保存请求优先通过 `AstrBotPluginPage` bridge 转发，避免插件页 iframe sandbox 导致直接请求失败。
4. 模板保存接口新增 JSON/base64 图片提交兼容，同时保留原 multipart 上传方式。
5. 补充编辑器脚本语法检查和插件 Python 文件编译、Ruff 校验，确保本次保存流程改动可正常加载。