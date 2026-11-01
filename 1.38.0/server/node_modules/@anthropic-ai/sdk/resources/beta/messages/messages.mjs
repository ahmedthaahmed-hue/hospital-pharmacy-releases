import * as BatchesAPI from "./batches.mjs";
import { APIResource } from "../../../core/resource.mjs";
import { MODEL_NONSTREAMING_TOKENS } from "../../../internal/constants.mjs";
import { buildHeaders } from "../../../internal/headers.mjs";
import { startApiCallSpan } from "../../../internal/tracing.mjs";
import { messagesCreateSpanSettings, recordCountTokensResponse, recordMessagesCreateRequest, recordMessagesCreateResponse, } from "../../../lib/internal/tracing.mjs";
import { ATTR_GEN_AI_REQUEST_MODEL } from "../../../lib/internal/tracing/attributes.mjs";
import { parseBetaMessage, } from "../../../lib/beta-parser.mjs";
import { BetaMessageStream } from "../../../lib/BetaMessageStream.mjs";
import { messagesCreateHeaders, transformOutputFormat } from "../../../lib/internal/beta-messages-request.mjs";
import { BetaToolRunner, } from "../../../lib/tools/BetaToolRunner.mjs";
import { ToolError } from "../../../lib/tools/ToolError.mjs";
import { Batches, } from "./batches.mjs";
const DEPRECATED_MODELS = {
    'claude-sonnet-4-5': 'November 30th, 2026',
    'claude-sonnet-4-5-20250929': 'November 30th, 2026',
};
const MODELS_TO_WARN_WITH_THINKING_ENABLED = ['claude-mythos-preview', 'claude-opus-4-6'];
export var Messages = /* @__PURE__ */ (() => {
    class Messages extends APIResource {
        constructor() {
            super(...arguments);
            this.batches = new BatchesAPI.Batches(this._client);
        }
        create(params, options) {
            // Transform deprecated output_format to output_config.format
            const modifiedParams = transformOutputFormat(params);
            const { betas, user_profile_id, workspace_id, ...body } = modifiedParams;
            if (body.model in DEPRECATED_MODELS) {
                console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS[body.model]}\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
            }
            if (MODELS_TO_WARN_WITH_THINKING_ENABLED.includes(body.model) &&
                body.thinking &&
                body.thinking.type === 'enabled') {
                console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
            }
            let timeout = options?.timeout ?? this._client._options.timeout;
            if (!body.stream && timeout == null) {
                const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? undefined;
                timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
            }
            const headers = messagesCreateHeaders(modifiedParams, options);
            // A client whose spans are disabled computes nothing for one, and returns its request as it is.
            const call = this._client._tracer &&
                startApiCallSpan(this._client, 'anthropic.messages.create', options, messagesCreateSpanSettings(this._client, body, headers));
            recordMessagesCreateRequest(this._client, call, body);
            const request = this._client.post('/v1/messages?beta=true', {
                body,
                timeout: timeout ?? 600000,
                ...options,
                __span: call,
                headers,
                stream: modifiedParams.stream ?? false,
            });
            return (call ?
                request._thenUnwrap((data) => {
                    recordMessagesCreateResponse(this._client, call, body, data);
                    return data;
                })
                : request);
        }
        /**
         * Send a structured list of input messages with text and/or image content, along with an expected `output_format` and
         * the response will be automatically parsed and available in the `parsed_output` property of the message.
         *
         * @example
         * ```ts
         * const message = await client.beta.messages.parse({
         *   model: 'claude-3-5-sonnet-20241022',
         *   max_tokens: 1024,
         *   messages: [{ role: 'user', content: 'What is 2+2?' }],
         *   output_format: zodOutputFormat(z.object({ answer: z.number() }), 'math'),
         * });
         *
         * console.log(message.parsed_output?.answer); // 4
         * ```
         */
        parse(params, options) {
            options = {
                ...options,
                headers: buildHeaders([
                    { 'anthropic-beta': [...(params.betas ?? []), 'structured-outputs-2025-12-15'].toString() },
                    options?.headers,
                ]),
            };
            return this.create(params, options).then((message) => parseBetaMessage(message, params, { logger: this._client.logger ?? console }));
        }
        /**
         * Create a Message stream
         */
        stream(body, options) {
            return BetaMessageStream.createMessage(this, body, options, { client: this._client });
        }
        /**
         * Count the number of tokens in a Message.
         *
         * The Token Count API can be used to count the number of tokens in a Message,
         * including tools, images, and documents, without creating it.
         *
         * Learn more about token counting in our
         * [user guide](https://platform.claude.com/docs/en/build-with-claude/token-counting)
         *
         * @example
         * ```ts
         * const betaMessageTokensCount =
         *   await client.beta.messages.countTokens({
         *     messages: [{ content: 'Hello, world', role: 'user' }],
         *     model: 'claude-opus-5-5',
         *   });
         * ```
         */
        countTokens(params, options) {
            // Transform deprecated output_format to output_config.format
            const modifiedParams = transformOutputFormat(params);
            const { betas, user_profile_id, workspace_id, ...body } = modifiedParams;
            const headers = buildHeaders([
                {
                    'anthropic-beta': [...(betas ?? []), 'token-counting-2024-11-01'].toString(),
                    ...(user_profile_id != null ? { 'anthropic-user-profile-id': user_profile_id } : undefined),
                    ...(workspace_id != null ? { 'anthropic-workspace-id': workspace_id } : undefined),
                },
                options?.headers,
            ]);
            const call = startApiCallSpan(this._client, 'anthropic.messages.count_tokens', options, {
                route: '/v1/messages/count_tokens',
                attributes: { [ATTR_GEN_AI_REQUEST_MODEL]: body.model },
            });
            const request = this._client.post('/v1/messages/count_tokens?beta=true', {
                body,
                ...options,
                __span: call,
                headers,
            });
            // Only a request with a span has a response to record.
            return call ?
                request._thenUnwrap((count) => {
                    recordCountTokensResponse(this._client, call, count);
                    return count;
                })
                : request;
        }
        toolRunner(body, options) {
            return new BetaToolRunner(this._client, body, options);
        }
    }
    Messages.Batches = Batches;
    Messages.BetaToolRunner = BetaToolRunner;
    Messages.ToolError = ToolError;
    return Messages;
})();
export const BETA_BROWSER_MEMBER_NAME_VALUES = [
    'navigate',
    'list_tabs',
    'new_tab',
    'switch_tab',
    'close_tab',
    'read_page',
    'get_page_text',
    'read_console',
    'read_network',
    'find',
    'form_input',
    'file_upload',
    'scroll_to',
    'screenshot',
    'zoom',
    'left_click',
    'right_click',
    'middle_click',
    'double_click',
    'triple_click',
    'hover',
    'left_click_drag',
    'left_mouse_down',
    'left_mouse_up',
    'mouse_move',
    'scroll',
    'type',
    'key',
    'hold_key',
    'wait',
    'javascript_exec',
];
export const BETA_CLIENT_TOOL_UNION_KEYS = [
    'input_schema',
    'name',
    'allowed_callers',
    'cache_control',
    'defer_loading',
    'description',
    'eager_input_streaming',
    'input_examples',
    'strict',
    'type',
    'configs',
    'display_height_px',
    'display_width_px',
    'display_number',
    'enable_zoom',
    'max_characters',
];
export const BETA_COMPUTER_MEMBER_NAME_VALUES = [
    'key',
    'hold_key',
    'type',
    'cursor_position',
    'mouse_move',
    'left_mouse_down',
    'left_mouse_up',
    'left_click',
    'left_click_drag',
    'right_click',
    'middle_click',
    'double_click',
    'triple_click',
    'scroll',
    'wait',
    'screenshot',
    'zoom',
];
export { BetaToolRunner } from "../../../lib/tools/BetaToolRunner.mjs";
export { ToolError } from "../../../lib/tools/ToolError.mjs";
//# sourceMappingURL=messages.mjs.map