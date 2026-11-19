'use client';

import { useEffect, useState } from 'react';
import type { SyncOptions } from '@/lib/services/sync/types';

export type TeamUser = NonNullable<SyncOptions['teamUsers']>[number];

interface ApiUser {
  name: string;
  teamId: string;
  igniteAccountId: string;
  hmgAccountId: string;
  hmgUserId: string;
}

/**
 * 같은 팀 사용자 목록 (계정 매핑용)
 * users 테이블은 anon RLS 차단이라 API route 경유로 조회
 */
export function useTeamUsers(teamId: string | null | undefined): TeamUser[] {
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([]);

  useEffect(() => {
    if (!teamId) return;

    fetch('/api/users')
      .then((r) => r.json())
      .then((res: { success: boolean; data?: ApiUser[] }) => {
        if (res.success && res.data) {
          setTeamUsers(
            res.data
              .filter((u) => u.teamId === teamId)
              .map((u) => ({
                name: u.name,
                igniteAccountId: u.igniteAccountId || '',
                hmgAccountId: u.hmgAccountId || '',
                hmgUserId: u.hmgUserId || '',
              }))
          );
        }
      })
      .catch((error) => console.error('팀 사용자 목록 조회 실패:', error));
  }, [teamId]);

  return teamUsers;
}
