import { expect, test } from "bun:test"
import { anthropicToResponses, responsesToAnthropic } from "../router/anthropic-compat"

test("converts Anthropic messages, tools, and tool results to Responses input", () => {
  const converted = anthropicToResponses({
    model: "gpt-5.6-terra",
    system: "Be concise.",
    messages: [
      { role: "user", content: "List files." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "list_dir", input: { path: "." } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "README.md" }] },
    ],
    tools: [
      {
        name: "list_dir",
        description: "Lists files",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  })

  expect(converted.request).toMatchObject({
    model: "gpt-5.6-terra",
    stream: false,
    tools: [{ type: "function", name: "list_dir" }],
    reasoning: { effort: "high" },
    input: [
      { role: "system", content: [{ type: "input_text", text: "Be concise." }] },
      { role: "user", content: [{ type: "input_text", text: "List files." }] },
      { role: "assistant", content: [{ type: "function_call", call_id: "toolu_1", name: "list_dir" }] },
      { role: "user", content: [{ type: "function_call_output", call_id: "toolu_1", output: "README.md" }] },
    ],
  })
})

test("does not invent Responses reasoning when Claude omits an effort level", () => {
  const converted = anthropicToResponses({
    model: "gpt-5.6-terra",
    messages: [{ role: "user", content: "Hello" }],
    thinking: { type: "enabled", budget_tokens: 4096 },
  })

  expect(converted.request.reasoning).toBeUndefined()
})

test.each(["low", "medium", "high", "xhigh", "max"])(
  "preserves Claude effort %s exactly in Responses reasoning",
  (effort) => {
    const converted = anthropicToResponses({
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "Hello" }],
      thinking: { type: "adaptive" },
      output_config: { effort },
    })

    expect(converted.request.reasoning).toEqual({ effort })
  },
)

test("converts Responses text and function calls to an Anthropic message", () => {
  const converted = responsesToAnthropic(
    {
      id: "resp_123",
      model: "gpt-5.6-terra",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "I can help." }] },
        { type: "function_call", call_id: "call_123", name: "list_dir", arguments: '{"path":"."}' },
      ],
      usage: { input_tokens: 12, output_tokens: 8 },
    },
    "fallback-model",
  )

  expect(converted).toEqual({
    id: "resp_123",
    type: "message",
    role: "assistant",
    model: "gpt-5.6-terra",
    content: [
      { type: "text", text: "I can help." },
      { type: "tool_use", id: "call_123", name: "list_dir", input: { path: "." } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 8 },
  })
})
