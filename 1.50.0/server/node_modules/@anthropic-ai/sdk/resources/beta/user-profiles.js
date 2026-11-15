"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserProfiles = void 0;
const resource_1 = require("../../core/resource.js");
const pagination_1 = require("../../core/pagination.js");
const headers_1 = require("../../internal/headers.js");
const tracing_1 = require("../../internal/tracing.js");
const path_1 = require("../../internal/utils/path.js");
class UserProfiles extends resource_1.APIResource {
    /**
     * Create User Profile
     *
     * @example
     * ```ts
     * const betaUserProfile =
     *   await client.beta.userProfiles.create();
     * ```
     */
    create(params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post('/v1/user_profiles?beta=true', {
            body,
            ...options,
            headers: (0, headers_1.buildHeaders)([
                {
                    'anthropic-beta': [...(betas ?? []), 'user-profiles-2026-08-18'].toString(),
                    ...(workspace_id != null ? { 'anthropic-workspace-id': workspace_id } : undefined),
                },
                options?.headers,
            ]),
            __span: (0, tracing_1.startApiCallSpan)(this._client, 'anthropic.user_profiles.create', options, {
                route: '/v1/user_profiles',
                createdIDAttribute: 'anthropic.user_profile.id',
            }),
        });
    }
    /**
     * Get User Profile
     *
     * @example
     * ```ts
     * const betaUserProfile =
     *   await client.beta.userProfiles.retrieve(
     *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
     *   );
     * ```
     */
    retrieve(userProfileID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get((0, path_1.path) `/v1/user_profiles/${userProfileID}?beta=true`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([
                {
                    'anthropic-beta': [...(betas ?? []), 'user-profiles-2026-08-18'].toString(),
                    ...(workspace_id != null ? { 'anthropic-workspace-id': workspace_id } : undefined),
                },
                options?.headers,
            ]),
            __span: (0, tracing_1.startApiCallSpan)(this._client, 'anthropic.user_profiles.retrieve', options, {
                route: '/v1/user_profiles/{user_profile_id}',
                attributes: { 'anthropic.user_profile.id': userProfileID },
            }),
        });
    }
    /**
     * Update User Profile
     *
     * @example
     * ```ts
     * const betaUserProfile =
     *   await client.beta.userProfiles.update(
     *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
     *   );
     * ```
     */
    update(userProfileID, params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post((0, path_1.path) `/v1/user_profiles/${userProfileID}?beta=true`, {
            body,
            ...options,
            headers: (0, headers_1.buildHeaders)([
                {
                    'anthropic-beta': [...(betas ?? []), 'user-profiles-2026-08-18'].toString(),
                    ...(workspace_id != null ? { 'anthropic-workspace-id': workspace_id } : undefined),
                },
                options?.headers,
            ]),
            __span: (0, tracing_1.startApiCallSpan)(this._client, 'anthropic.user_profiles.update', options, {
                route: '/v1/user_profiles/{user_profile_id}',
                attributes: { 'anthropic.user_profile.id': userProfileID },
            }),
        });
    }
    /**
     * List User Profiles
     *
     * @example
     * ```ts
     * // Automatically fetches more pages as needed.
     * for await (const betaUserProfile of client.beta.userProfiles.list()) {
     *   // ...
     * }
     * ```
     */
    list(params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList('/v1/user_profiles?beta=true', (pagination_1.PageCursor), {
            query,
            ...options,
            headers: (0, headers_1.buildHeaders)([
                {
                    'anthropic-beta': [...(betas ?? []), 'user-profiles-2026-08-18'].toString(),
                    ...(workspace_id != null ? { 'anthropic-workspace-id': workspace_id } : undefined),
                },
                options?.headers,
            ]),
            __span: (0, tracing_1.startApiCallSpan)(this._client, 'anthropic.user_profiles.list', options, {
                route: '/v1/user_profiles',
                queryParams: ['limit', 'order', 'order_by', 'page'],
            }),
        });
    }
    /**
     * Create Enrollment URL
     *
     * @example
     * ```ts
     * const betaUserProfileEnrollmentURL =
     *   await client.beta.userProfiles.createEnrollmentURL(
     *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
     *   );
     * ```
     */
    createEnrollmentURL(userProfileID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.post((0, path_1.path) `/v1/user_profiles/${userProfileID}/enrollment_url?beta=true`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([
                {
                    'anthropic-beta': [...(betas ?? []), 'user-profiles-2026-08-18'].toString(),
                    ...(workspace_id != null ? { 'anthropic-workspace-id': workspace_id } : undefined),
                },
                options?.headers,
            ]),
            __span: (0, tracing_1.startApiCallSpan)(this._client, 'anthropic.user_profiles.create_enrollment_url', options, {
                route: '/v1/user_profiles/{user_profile_id}/enrollment_url',
                attributes: { 'anthropic.user_profile.id': userProfileID },
            }),
        });
    }
}
exports.UserProfiles = UserProfiles;
//# sourceMappingURL=user-profiles.js.map