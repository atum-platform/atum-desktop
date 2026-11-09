# Atum Desktop — 可查看源代码

本仓库包含 Atum Desktop 及其基于 Hermes 的运行时所发布的源代码。Atum 自有代码保留所有权利；除 GitHub 公共仓库条款要求的查看与派生仓库权利外，不授予其他许可。继承的 Hermes 代码继续适用 MIT 许可证，其他第三方许可证与署名也保持有效。请阅读 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [THIRD-PARTY.json](THIRD-PARTY.json)。

本地检查：运行 `npm ci --ignore-scripts`，然后运行 `npm run typecheck --workspace apps/desktop`。集成方应提供自己的部署配置；本仓库不包含生产环境配置。

Atum 的问题、建议与贡献请提交到[本仓库的问题列表](../../issues)和[拉取请求](../../pulls)，并阅读[贡献指南](CONTRIBUTING.md)。安全问题请私下报告，详见 [SECURITY.md](SECURITY.md)。

Atum 基于 [Nous Research 的 Hermes Agent](https://github.com/NousResearch/hermes-agent) 开发。相关上游署名与许可证均予以保留。
