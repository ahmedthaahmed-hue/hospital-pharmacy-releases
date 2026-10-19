"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CostReport = void 0;
const resource_1 = require("../../../../core/resource.js");
const pagination_1 = require("../../../../core/pagination.js");
const tracing_1 = require("../../../../internal/tracing.js");
class CostReport extends resource_1.APIResource {
    /**
     * Get cost in USD over time across a date range.
     *
     * Returns cost bucketed by minute, hour, or day, optionally broken down by
     * product, model, context window, inference region, speed, cost type, or token
     * type. Available to organizations on a Claude Enterprise plan. Requires an API
     * key with the `read:analytics` scope.
     *
     * @example
     * ```ts
     * // Automatically fetches more pages as needed.
     * for await (const betaAnalyticsCostReportTimeBucket of client.beta.organization.analytics.costReport.list(
     *   { starting_at: '2019-12-27T18:11:19.117Z' },
     * )) {
     *   // ...
     * }
     * ```
     */
    list(query, options) {
        return this._client.getAPIList('/v1/organizations/analytics/cost_report?beta=true', (pagination_1.PageCursor), {
            query,
            ...options,
            __span: (0, tracing_1.startApiCallSpan)(this._client, 'anthropic.organization.analytics.cost_report.list', options, {
                route: '/v1/organizations/analytics/cost_report',
                queryParams: [
                    'bucket_width',
                    'claude_tag_categories',
                    'claude_tag_user_ids',
                    'context_windows',
                    'ending_at',
                    'group_by',
                    'inference_geos',
                    'limit',
                    'models',
                    'page',
                    'products',
                    'rbac_group_ids',
                    'slack_channel_ids',
                    'speeds',
                    'starting_at',
                    'user_ids',
                ],
            }),
        });
    }
}
exports.CostReport = CostReport;
//# sourceMappingURL=cost-report.js.map