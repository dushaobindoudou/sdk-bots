# 示例

用本机 dsh 里配好的 OpenRouter 免费凭证，跑一个最小群聊。

```bash
NODE_OPTIONS="--use-system-ca" pnpm example:group-chat
```

自定义话题：

```bash
NODE_OPTIONS="--use-system-ca" pnpm example:group-chat -- 帮我想一个周末徒步计划
```

会做这些事：

1. 读取凭证：`OPENROUTER_API_KEY`，否则 `~/.dsh/.credentials.yaml` 的 `FREEROUTE_OPENROUTER_API_KEY`
2. 启动无头 host（临时数据目录，不写 `~/.sdk-bots`）
3. 创建两个 bot（研究员、写手）和一个群（周末小队）
4. 把推理切到 `openrouter`，默认免费模型 `nvidia/nemotron-3.5-lightning:free`
5. 先打一轮群聊，再问写手一句

换模型：

```bash
SAND_OPENROUTER_MODEL=openrouter/free NODE_OPTIONS="--use-system-ca" pnpm example:group-chat
```
