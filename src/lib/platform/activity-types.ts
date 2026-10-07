export type ActivitySection =
  | 'members'
  | 'invitations'
  | 'channels'
  | 'history';
export interface ActivityPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface PlatformMember {
  user_id: string;
  full_name: string | null;
  email: string | null;
  account_role: string;
  created_at: string;
}
export interface PlatformInvitation {
  id: string;
  label: string | null;
  role: string;
  created_at: string;
  expires_at: string;
}
export interface PlatformChannel {
  id: string;
  kind: 'official' | 'qr';
  identifier: string | null;
  display_name: string | null;
  status: string;
  connected_at: string | null;
  updated_at: string;
}
export interface PlatformHistory {
  id: string;
  action: string;
  actor_name: string | null;
  created_at: string;
}
export type ActivityItem =
  | PlatformMember
  | PlatformInvitation
  | PlatformChannel
  | PlatformHistory;
export const ACTIVITY_PAGE_SIZE = 25;
