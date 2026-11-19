"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Completions = void 0;
const resource_1 = require("../core/resource.js");
const headers_1 = require("../internal/headers.js");
const tracing_1 = require("../internal/tracing.js");
class Completions extends resource_1.APIResource {
    create(params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post('/v1/complete', {
            body,
            timeout: this._client._options.timeout ?? 600000,
            ...options,
            headers: (0, headers_1.buildHeaders)([
                {
                    ...(betas?.toString() != null ? { 'anthropic-beta': betas?.toString() } : undefined),
                    ...(workspace_id != null ? { 'anthropic-workspace-id': workspace_id } : undefined),
                },
                options?.headers,
            ]),
            stream: params.stream ?? false,
            __span: (0, tracing_1.startApiCallSpan)(this._client, 'anthropic.completions.create', options, {
                route: '/v1/complete',
            }),
        });
    }
}
exports.Completions = Completions;
//# sourceMappingURL=completions.js.map