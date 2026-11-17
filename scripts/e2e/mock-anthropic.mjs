// 模拟模型接口，按剧本驱动 Agent 走完一轮工具调用，用于无 API Key 的端到端测试。
// 同时提供 Anthropic Messages（/v1/messages）与 OpenAI Chat Completions（/v1/chat/completions）两种流式接口，剧本相同。
// 用法：node scripts/e2e/mock-anthropic.mjs   （监听 127.0.0.1:8790）
//   Anthropic：ANTHROPIC_BASE_URL=http://127.0.0.1:8790 ANTHROPIC_API_KEY=test
//   OpenAI：   AGENT_PROVIDER=openai OPENAI_BASE_URL=http://127.0.0.1:8790/v1 OPENAI_API_KEY=test
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8790);
const requests = [];

function sse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

/** 根据对话进度决定本轮输出哪些内容块 */
function script(body) {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  const toolResults = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
  const userText = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : last.content;
  const step = msgs.filter((m) => m.role === 'assistant').length; // 已完成的助手轮数（含历史对话）
  const turnStart = msgs.findLastIndex((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'text'));
  const k = msgs.slice(turnStart).filter((m) => m.role === 'assistant').length; // 本轮第几步

  if (userText?.includes('SLOW')) {
    // 用于测试“停止”：先调用一个工具，之后每步都慢慢输出
    return { blocks: [{ type: 'text', text: '处理中……' }, { type: 'tool_use', name: 'list_files', input: {} }], stop: 'tool_use', delayMs: 1500 };
  }
  // 「测试连接」请求
  if (String(body.system ?? '').startsWith('You are a connectivity check')) return { blocks: [{ type: 'text', text: 'OK' }], stop: 'end_turn' };
  // 上下文压缩：服务端请求写摘要（系统提示以 "You compress the history" 开头）
  if (String(body.system ?? '').startsWith('You compress the history')) {
    const covered = JSON.stringify(msgs).includes('CONTEXT 1') ? 'covers CONTEXT 1' : 'empty';
    return { blocks: [{ type: 'text', text: `SUMMARY-OK (${covered}): the user is testing context compaction; big.tex was read several times.` }], stop: 'end_turn' };
  }
  // 本轮用户消息（后续步骤的最后一条消息是工具结果）
  // 压缩后的对话摘要也作为文本块放在本轮消息前面，判断剧本时忽略它
  const turnText = turnStart >= 0 ? msgs[turnStart].content.filter((b) => b.type === 'text' && !b.text.startsWith('<conversation_summary>')).map((b) => b.text).join('\n') : '';
  if (turnText.includes('PING')) return { blocks: [{ type: 'text', text: 'PONG' }], stop: 'end_turn' };
  if (turnText.includes('CONTEXT 1')) {
    // 长对话：反复读取大文件，最后输出一大段文字（无法通过清理工具结果缩短）
    if (k < 4) return { blocks: [{ type: 'tool_use', name: 'read_file', input: { path: 'big.tex' } }], stop: 'tool_use' };
    return { blocks: [{ type: 'text', text: 'LONG-ANSWER ' + 'lorem ipsum dolor sit amet '.repeat(1200) }], stop: 'end_turn' };
  }
  if (turnText.includes('CONTEXT 2')) {
    return { blocks: [{ type: 'text', text: 'CONTEXT 2 done.' }], stop: 'end_turn' };
  }
  if (turnText.includes('TOOLS')) {
    // 统一工具注册表：一次发出多个只读调用（应并行执行、按原顺序返回），再用 apply_patch 做多处原子修改
    switch (k) {
      case 0:
        return {
          blocks: [
            { type: 'text', text: '先了解项目结构。' },
            { type: 'tool_use', name: 'get_outline', input: {} },
            { type: 'tool_use', name: 'get_project_dependencies', input: {} },
            { type: 'tool_use', name: 'grep', input: { pattern: '\\\\title' } },
            { type: 'tool_use', name: 'get_pdf_pages', input: { pages: '1', scale: 0.6 } },
          ],
          stop: 'tool_use',
        };
      case 1: {
        const names = ['get_outline', 'get_project_dependencies', 'grep'];
        if (toolResults.length !== 4) throw new Error(`expected 4 tool results, got ${toolResults.length}`);
        const prev = msgs[msgs.length - 2].content.filter((b) => b.type === 'tool_use');
        toolResults.forEach((r, i) => { if (r.tool_use_id !== prev[i].id) throw new Error('tool results out of order'); });
        for (const [i, n] of names.entries()) if (toolResults[i].is_error) throw new Error(`${n} failed: ${JSON.stringify(toolResults[i].content).slice(0, 300)}`);
        return {
          blocks: [
            {
              type: 'tool_use',
              name: 'apply_patch',
              input: { edits: [
                { path: 'main.tex', old_str: '\\section{Introduction}', new_str: '\\section{Introduction}\\label{sec:intro}' },
                { path: 'notes.tex', old_str: '', new_str: 'See Section~\\ref{sec:intro}.\n' },
              ] },
            },
          ],
          stop: 'tool_use',
        };
      }
      case 2:
        if (!toolResults[0] || toolResults[0].is_error) throw new Error(`apply_patch failed: ${JSON.stringify(toolResults[0]?.content)}`);
        return { blocks: [{ type: 'text', text: 'TOOLS 完成。' }], stop: 'end_turn' };
      default:
        return { blocks: [{ type: 'text', text: 'done' }], stop: 'end_turn' };
    }
  }
  switch (k) {
    case 0:
      return {
        blocks: [
          { type: 'thinking', thinking: '先看一下主文件的内容。' },
          { type: 'text', text: '我来修改标题并新增一个章节。' },
          { type: 'tool_use', name: 'read_file', input: { path: 'main.tex' } },
        ],
        stop: 'tool_use',
      };
    case 1:
      if (!toolResults[0] || toolResults[0].is_error) throw new Error('expected read_file result');
      return {
        blocks: [
          { type: 'thinking', thinking: '修改标题，同时新建 sections/method.tex。' },
          { type: 'tool_use', name: 'str_replace', input: { path: 'main.tex', old_str: '\\title{Server Side Title}', new_str: '\\title{A Mocked Agent Title}' } },
          { type: 'tool_use', name: 'write_file', input: { path: 'sections/method.tex', content: '\\section{Method}\nWe propose a method.\n' } },
          // 故意给出一个不存在的 old_str，验证错误会作为 is_error 返回给模型
          { type: 'tool_use', name: 'str_replace', input: { path: 'main.tex', old_str: 'NOT_IN_FILE', new_str: 'x' } },
        ],
        stop: 'tool_use',
      };
    case 2:
      return { blocks: [{ type: 'tool_use', name: 'compile', input: {} }], stop: 'tool_use' };
    default:
      return { blocks: [{ type: 'text', text: '完成：标题已修改，新增了 `sections/method.tex`。' }], stop: 'end_turn' };
  }
}

/** OpenAI 消息 → 剧本使用的 Anthropic 风格消息 */
function fromOpenAI(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || '{}') });
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content, ...(m.content.startsWith('ERROR: ') ? { is_error: true } : {}) };
      const last = out.at(-1);
      if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else {
      const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      const blocks = parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', url: p.image_url.url }));
      // 工具结果的图片以单独的 user 消息附上：并入前一条工具结果消息，不算新的一轮
      const last = out.at(-1);
      if (blocks[0]?.type === 'text' && blocks[0].text.startsWith('Images returned by the tool calls above') && last?.content.every((b) => b.type === 'tool_result')) {
        last.content.push(...blocks.slice(1));
      } else out.push({ role: 'user', content: blocks });
    }
  }
  return out;
}

async function serveOpenAI(req, res, body, raw) {
  let plan;
  try {
    plan = script({ ...body, system: body.messages.find((m) => m.role === 'system')?.content, messages: fromOpenAI(body.messages) });
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: String(e.message), type: 'invalid_request_error' } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const id = `chatcmpl_${requests.length}`;
  const send = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
  let aborted = false;
  req.on('close', () => { aborted = true; });
  let toolIndex = 0;
  for (const [index, b] of plan.blocks.entries()) {
    if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
    if (aborted) return;
    if (b.type === 'thinking') send({ reasoning_content: b.thinking });
    else if (b.type === 'text') for (const piece of b.text.match(/.{1,6}/gsu)) send({ content: piece });
    else if (b.type === 'tool_use') {
      const i = toolIndex++;
      send({ tool_calls: [{ index: i, id: `call_${requests.length}_${index}`, type: 'function', function: { name: b.name, arguments: '' } }] });
      const json = JSON.stringify(b.input);
      for (let k = 0; k < json.length; k += 12) send({ tool_calls: [{ index: i, function: { arguments: json.slice(k, k + 12) } }] });
    }
  }
  send({}, plan.stop === 'tool_use' ? 'tool_calls' : plan.stop === 'max_tokens' ? 'length' : 'stop');
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: Math.ceil(JSON.stringify(body).length / 4), completion_tokens: Math.ceil(JSON.stringify(plan.blocks).length / 4), prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/_requests') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(requests));
  }
  const isOpenAI = req.method === 'POST' && req.url.startsWith('/v1/chat/completions');
  if (req.method !== 'POST' || (!req.url.startsWith('/v1/messages') && !isOpenAI)) {
    res.writeHead(404);
    return res.end();
  }
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  requests.push({ url: req.url, headers: { 'anthropic-beta': req.headers['anthropic-beta'], 'x-api-key': req.headers['x-api-key'], authorization: req.headers.authorization }, body });
  if (isOpenAI) return serveOpenAI(req, res, body, raw);

  let plan;
  try {
    plan = script(body);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: String(e.message) } }));
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const id = `msg_${requests.length}`;
  sse(res, 'message_start', {
    message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  let aborted = false;
  req.on('close', () => { aborted = true; });
  for (const [index, b] of plan.blocks.entries()) {
    if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
    if (aborted) return;
    if (b.type === 'thinking') {
      sse(res, 'content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      sse(res, 'content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      sse(res, 'content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig_' + index } });
    } else if (b.type === 'text') {
      sse(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const piece of b.text.match(/.{1,6}/gsu)) sse(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
    } else if (b.type === 'tool_use') {
      const tid = `toolu_${requests.length}_${index}`;
      sse(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: tid, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      // 分片发送参数，模拟 eager_input_streaming
      for (let i = 0; i < json.length; i += 12) sse(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 12) } });
    }
    sse(res, 'content_block_stop', { index });
  }
  sse(res, 'message_delta', { delta: { stop_reason: plan.stop, stop_sequence: null }, usage: { output_tokens: Math.ceil(JSON.stringify(plan.blocks).length / 4) } });
  sse(res, 'message_stop', {});
  res.end();
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock anthropic listening on ${PORT}`));
