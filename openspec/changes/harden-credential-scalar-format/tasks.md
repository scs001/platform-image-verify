# Tasks: harden-credential-scalar-format

实施仓：`/Users/chengsishi/paas`（平台侧凭据写入器在 `dsh-profile.js`）。

## 1. 写出格式硬化

- [x] 1.1 `dsh-profile.js:350`：凭据写出改为 `yaml.dump(doc, { lineWidth: -1, forceQuotes: true })`
      （`-1` 而非 `0`——design D1，js-yaml 的 `0` 表示「保持在 0 列内」仍会折叠）
- [x] 1.2 确认其余 9 处 `yaml.dump`（settings/mcp/skills/presets/permissions/tool-search/
      chart-bind/user-questions）**不动**——它们不是凭据载体

## 2. 测试

- [x] 2.1 单测：`writeCredentialsStore` 写出后，93 字符 PAT 与 71 字符 sk-* 均为单行
      `name: 'value'`（断言文件中无 `>-`/`|-`/续行缩进）
- [x] 2.2 单测：值语义等价——新格式加载出的 ref 值与输入字节相同（含含特殊字符的 gh_actor）
- [x] 2.3 单测：单行 grep+sed 式取值得完整值（把 spec 的「单行取值」场景钉成可执行断言）

## 3. 上线与验证

- [ ] 3.1 镜像构建（标准 TCR 线：GHA→hkccr→relay→ccr）+ cheap-1 compose 滚版
- [ ] 3.2 生产实证：删掉 runner-c 上 spider-heal child 的旧 `.credentials.yaml` 后重建
      （或重部署带 secrets），`cat` 确认 `git_pat: 'github_pat_…'` 单行引号
- [ ] 3.3 归档 openspec change（validate --specs 通过后）
