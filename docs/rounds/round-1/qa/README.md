# qa · 质量调查记录

设计前的实证调查（文档即接口，供设计与实现引用）。

| 文件 | 结论一句话 |
|---|---|
| `pi-cross-process-sync-investigation.md` | pi 事件是进程内的、无跨进程推送；CLI 感知 Web 操作走三条通道；挖出三个 v2.0 必补缺口（审计条目 / baseVersion / watcher 增强） |
| `legacy-rollback-investigation.md` | 旧仓回滚机制考古：回滚=追加新版、乐观锁、原子写、EXTERNAL_MODIFIED 全文比对，均沿用；旧仓无审计无通知（file:line 级证据） |
