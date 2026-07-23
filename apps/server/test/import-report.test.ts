import { describe, expect, it } from 'vitest';
import {
  addTelegramDesktopImportIssue,
  createTelegramDesktopImportReport,
  finishTelegramDesktopImportReport,
  IMPORT_REPORT_ISSUE_LIMIT,
  renderTelegramDesktopImportReport,
  telegramDesktopImportExitCode,
} from '../src/imports/report.js';

function report() {
  return createTelegramDesktopImportReport({
    fileSha256: 'a'.repeat(64),
    mode: 'dry-run',
    selectedChats: [
      {
        canonicalChannelId: '-1002234260754',
        name: 'Test channel',
        source: 'root',
        sourceChatId: '2234260754',
      },
    ],
    startedAt: new Date('2026-07-24T00:00:00.000Z'),
  });
}

describe('Telegram Desktop import report', () => {
  it('renders versioned JSON without message content or local paths', () => {
    const value = finishTelegramDesktopImportReport(report(), new Date('2026-07-24T00:01:00.000Z'));
    const rendered = renderTelegramDesktopImportReport(value, true);

    expect(JSON.parse(rendered)).toMatchObject({
      completedAt: '2026-07-24T00:01:00.000Z',
      fileSha256: 'a'.repeat(64),
      mode: 'dry-run',
      parserVersion: 1,
      schemaVersion: 1,
      status: 'clean',
    });
    expect(rendered).not.toContain('/Users/');
    expect(rendered).not.toContain('message text');
    expect(telegramDesktopImportExitCode(value)).toBe(0);
  });

  it('bounds issue samples while retaining complete counts', () => {
    const value = report();
    for (let index = 0; index < IMPORT_REPORT_ISSUE_LIMIT + 5; index += 1) {
      addTelegramDesktopImportIssue(value, {
        code: 'invalid_message',
        sanitizedReason: 'The selected record is invalid',
        severity: 'error',
        sourceChatId: '2234260754',
        sourceMessageId: String(index),
      });
    }
    finishTelegramDesktopImportReport(value);

    expect(value.issues).toHaveLength(IMPORT_REPORT_ISSUE_LIMIT);
    expect(value.counts.itemErrors).toBe(IMPORT_REPORT_ISSUE_LIMIT + 5);
    expect(value.status).toBe('partial');
    expect(telegramDesktopImportExitCode(value)).toBe(2);
  });

  it('renders only sanitized identifiers and reasons in the human summary', () => {
    const value = report();
    value.runId = '019b-import-run';
    value.counts.scanned = 2;
    value.counts.eligible = 1;
    addTelegramDesktopImportIssue(value, {
      code: 'unsupported_entity',
      sanitizedReason: 'Visible text was preserved',
      severity: 'warning',
      sourceChatId: '2234260754',
      sourceMessageId: '17',
    });
    finishTelegramDesktopImportReport(value);

    expect(renderTelegramDesktopImportReport(value, false)).toContain(
      '[warning] unsupported_entity channel=2234260754 message=17: Visible text was preserved',
    );
    expect(value.status).toBe('clean');
  });
});
