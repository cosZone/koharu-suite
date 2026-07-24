import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';

const SOURCE_EVIDENCE_DISCOVERY_ADVISORY_LOCK = 6_309_648_946_926_691;

type SourceEvidenceTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Serializes source-media evidence commits with media-cache cursor reads.
 *
 * Writers acquire this immediately before inserting evidence. Discovery acquires
 * it before reading or advancing its keyset cursor, so an older in-flight row
 * cannot commit behind an already-advanced cursor.
 */
export async function lockSourceEvidenceDiscovery(
  transaction: SourceEvidenceTransaction,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(${SOURCE_EVIDENCE_DISCOVERY_ADVISORY_LOCK})`,
  );
}
