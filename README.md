# 金属文物脱盐监测工作台

纯前端应用：修复师在本地工作台为每个**方案**建立槽位、器物初始归属、目标上限（电导率，整数 µS/cm）与所需连续轮数；启动后逐轮提交覆盖该槽全部仍在浸泡器物的整数读数，系统据此判定**换液**与**出槽**资格，避免把单件短暂下降误作整槽合格。

## 业务规则

- **一轮读数**：必须恰含该槽每件在泡器物各一次读数（不多、不少、不重复），读数为不小于 0 的整数；各器物采样时间严格递增，且晚于本槽此前全部读数。
- **单件资格**：自上次换液以来，末尾连续达到规定轮数（≥2）、每一步严格下降、且末值不高于上限。
- **换液**：仅当该槽**全部**在泡器物共同达标时才可执行；执行后该槽轮次清零（进入新周期重新累计，历史记录保留）。
- **出槽**：器物自身达标即可出槽；出槽后不再接受读数，后续轮次只覆盖仍在浸泡的器物。
- **不可改写**：一切写入都是追加一条事件（建立方案 / 提交读数 / 换液 / 出槽 / 追溯补正），当前状态永远自首项记录重放生成，存储层不提供修改或删除入口。
- **追溯补正**：已提交的一整轮读数被抄错时，在槽位过程页对该轮提出**追加式**补正，而不是直接改写记录：
  - 只能替换原轮每件器物的非负整数读数，**器物集合、轮次位置与采样时刻完全保持不变**；同一原轮至多有一条有效补正。
  - 提交时把替代读数按原轮位置叠入，**自首项记录重放**，重新验证其后的每次读数、换液与出槽是否仍符合既有规则；任一既有处置失去依据即拒绝写入，并返回**最早受影响事件**（记录序号）及原因。
  - 补正成功后原读数与补正事件在不可改写过程里均可见（原读数划线、替代读数标注＊），当前趋势、资格与修订号一律以补正后的重放结果一致还原。
  - 补正同样以页面所见修订号提交，陈旧修订不得写入。
- **多标签页并发**：操作须以页面所见的**修订号**提交；修订号不一致（陈旧操作）拒绝写入并展示最新状态。其他标签页写入后本页自动刷新；刷新或重新打开后由 localStorage 中的事件日志重放还原相同过程与资格。

## 目录结构

```
index.html            入口
styles.css
src/
  domain/             纯领域逻辑（可在 Node 中测试）
    validate.js       方案与一轮读数校验
    events.js         事件构造器（写入前领域把关）
    replay.js         事件重放、连续下降轮数与资格派生
  store/
    recordStore.js    追加式事件日志 + 修订号冲突检测（存储后端可注入）
    browserStore.js   localStorage 后端 + 方案索引 + Web Locks 串行化
  ui/                 哈希路由与页面渲染
scripts/
  build.mjs           构建：模块加载检查 → 复制 dist → 入口引用校验 → health/version
  smoke.mjs           业务模块冒烟（完整流程断言）
  verify.mjs          一次性验证：测试 → 构建 → 冒烟，以退出码报告
  serve.mjs           本地开发静态服务器
tests/                node:test 单元测试
deploy/nginx.conf     静态站点配置（含 /health）
Dockerfile            多阶段：base / verify / build / web
docker-compose.yml    web（端口可配）+ verify（一次性）
```

## 本地使用

```bash
npm run dev        # http://localhost:8080（零依赖，无需 npm install）
npm test           # 单元测试
npm run build      # 构建到 dist/
npm run smoke      # 业务模块冒烟
npm run verify     # 测试 + 构建 + 冒烟
```

## Docker

```bash
# 启动静态站点（宿主机端口默认 8080，可用 APP_PORT 或 .env 配置）
docker compose up -d web
APP_PORT=9000 docker compose up -d web

# 健康检查
curl http://localhost:8080/health

# 一次性验证：代码测试 + 构建 + 业务模块冒烟，以退出码报告结果
docker compose run --rm verify; echo $?
# 或
docker compose up --exit-code-from verify verify
```

- `web` 服务：nginx 提供静态站点与 `/health` 健康检查，镜像内置 `HEALTHCHECK`。
- `verify` 服务：依次执行 `node --test`、`scripts/build.mjs`、`scripts/smoke.mjs`，全部通过以退出码 0 自行退出，任一步失败以非零退出码报告。
