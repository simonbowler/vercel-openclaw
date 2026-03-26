/**
 * Deprecated — delegates to `/api/admin/prepare-restore`.
 *
 * This route exists for backwards compatibility. The authoritative
 * restore-readiness contract is `/api/admin/prepare-restore`.
 */
export { GET, POST } from "@/app/api/admin/prepare-restore/route";
