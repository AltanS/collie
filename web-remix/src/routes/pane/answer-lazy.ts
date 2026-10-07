// The pane's writes, loaded on the first one (S3). answer.ts and dialogs/actions.ts go through web's
// dialog guard and reply action, which need the harness (lib/harness-lazy.ts says why an islands page
// leaves it out of its first load). Each wrapper here imports its module when called; the static shell
// imports the same modules statically elsewhere, so there the import resolves at once.
import type { answerFeedback, answerMenu, answerOption, answerUnread, sendTypedReply } from "./answer";
import type { answerMultiSelect, answerPreview, answerWizard } from "./dialogs/actions";

const answer = () => import("./answer");
const dialogs = () => import("./dialogs/actions");

export const lazySendTypedReply = async (...args: Parameters<typeof sendTypedReply>) => (await answer()).sendTypedReply(...args);
export const lazyAnswerOption = async (...args: Parameters<typeof answerOption>) => (await answer()).answerOption(...args);
export const lazyAnswerFeedback = async (...args: Parameters<typeof answerFeedback>) => (await answer()).answerFeedback(...args);
export const lazyAnswerMenu = async (...args: Parameters<typeof answerMenu>) => (await answer()).answerMenu(...args);
export const lazyAnswerUnread = async (...args: Parameters<typeof answerUnread>) => (await answer()).answerUnread(...args);
export const lazyAnswerWizard = async (...args: Parameters<typeof answerWizard>) => (await dialogs()).answerWizard(...args);
export const lazyAnswerMultiSelect = async (...args: Parameters<typeof answerMultiSelect>) => (await dialogs()).answerMultiSelect(...args);
export const lazyAnswerPreview = async (...args: Parameters<typeof answerPreview>) => (await dialogs()).answerPreview(...args);
