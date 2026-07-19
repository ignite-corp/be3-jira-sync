import { Resend } from 'resend';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY 환경변수가 설정되지 않았습니다.');
    _resend = new Resend(apiKey);
  }
  return _resend;
}

// 알림 수신 주소 (팀별로 env로 설정)
const NOTIFY_EMAIL = process.env.SYNC_NOTIFY_EMAIL || '';

interface SyncFailure {
  ticketKey: string;
  error: string;
}

interface UserFailureSummary {
  userName: string;
  failures: SyncFailure[];
}

interface UserSuccessSummary {
  userName: string;
  processed: number;
  success: number;
  failed: number;
  created: number;
}

interface SendSyncReportEmailParams {
  userResults: UserSuccessSummary[];
  userFailures: UserFailureSummary[];
  syncDate: string;
  cutoffDate: string;
}

/**
 * Daily Sync 결과 이메일 발송 (매일 1회)
 * 성공/실패 관계없이 담당자별 결과를 정리하여 발송
 */
export async function sendSyncReportEmail({
  userResults,
  userFailures,
  syncDate,
  cutoffDate,
}: SendSyncReportEmailParams): Promise<void> {
  const totalProcessed = userResults.reduce((sum, u) => sum + u.processed, 0);
  const totalSuccess = userResults.reduce((sum, u) => sum + u.success, 0);
  const totalFailed = userResults.reduce((sum, u) => sum + u.failed, 0);
  const totalCreated = userResults.reduce((sum, u) => sum + u.created, 0);

  // 담당자별 결과
  const resultLines = userResults.map((u) => {
    const failTag = u.failed > 0 ? `, 실패 ${u.failed}건` : '';
    const createTag = u.created > 0 ? ` (신규 ${u.created}건)` : '';
    return `  ${u.userName}: 성공 ${u.success}건${createTag}${failTag} / 총 ${u.processed}건`;
  });

  // 실패 상세
  const failureSections = userFailures.map((u) => {
    const list = u.failures
      .map((f) => `    - ${f.ticketKey}: ${f.error}`)
      .join('\n');
    return `  [${u.userName}] (${u.failures.length}건)\n${list}`;
  });

  // cutoffDate (YYYY-MM-DD)를 n월 n일 형식으로 변환
  const [, cutoffMonth, cutoffDay] = cutoffDate.split('-');
  const cutoffLabel = `${Number(cutoffMonth)}월 ${Number(cutoffDay)}일`;

  const body = [
    `${syncDate} Daily Sync 결과`,
    `대상: 마감일 ${cutoffLabel} 이후 티켓`,
    '',
    `전체: 처리 ${totalProcessed}건, 성공 ${totalSuccess}건 (업데이트 ${totalSuccess - totalCreated}, 신규 ${totalCreated}), 실패 ${totalFailed}건`,
    '',
    '담당자별 결과:',
    ...resultLines,
  ];

  if (failureSections.length > 0) {
    body.push('', '실패 상세:', ...failureSections, '', '동기화 툴에서 수동 동기화를 시도하거나, 해당 담당자에게 문의해 주세요.');
  }

  const subjectStatus = totalFailed > 0
    ? `성공 ${totalSuccess}건, 실패 ${totalFailed}건`
    : `전체 성공 (${totalSuccess}건)`;

  if (!NOTIFY_EMAIL) {
    console.warn('[이메일] SYNC_NOTIFY_EMAIL 미설정 - 발송 스킵');
    return;
  }

  const { error } = await getResend().emails.send({
    from: 'Jira Sync <onboarding@resend.dev>',
    to: NOTIFY_EMAIL,
    subject: `[Jira Sync] Daily Sync (${syncDate}) — ${subjectStatus}`,
    text: body.join('\n'),
  });

  if (error) {
    console.error(`[이메일] 발송 실패:`, error);
  } else {
    console.log(`[이메일] ${NOTIFY_EMAIL}에 Daily Sync 결과 발송 완료`);
  }
}
