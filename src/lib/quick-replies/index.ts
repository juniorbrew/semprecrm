// ============================================================
// Quick replies module — public surface.
//
//   render     renderQuickReply, QUICK_REPLY_VARIABLES, variableToken
//   match      findSlashToken, matchQuickReplies, replaceSlashToken,
//              isValidShortcut
//   queries    listQuickReplies
//   mutations  createQuickReply, updateQuickReply, deleteQuickReply
//
// Import from '@/lib/quick-replies' (this file) or the sub-module.
// ============================================================

export * from './render';
export * from './match';
export * from './queries';
export * from './mutations';
