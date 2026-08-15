import LinqAPIV3 from '@linqapp/sdk';
import { config } from '../config.ts';

export const linq = new LinqAPIV3({
  apiKey: config.linq.apiKey,
  webhookSecret: config.linq.webhookSecret,
});

/** Linq's application error code for "recipient asked you to stop". */
export const OPT_OUT_ERROR_CODE = 2024;

interface LinqErrorShape {
  status?: number;
  error?: { code?: number };
  code?: number;
}

/**
 * True when a failed send was rejected because the recipient opted out.
 *
 * A 2024 is an authoritative answer, not a transient failure: it must be recorded
 * and never retried.
 */
export function isOptOutRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as LinqErrorShape;
  if (candidate.status !== 403) return false;
  return candidate.error?.code === OPT_OUT_ERROR_CODE || candidate.code === OPT_OUT_ERROR_CODE;
}

export type TextPart = { type: 'text'; value: string };
export type LinkPart = { type: 'link'; value: string };
export type MessagePart = TextPart | LinkPart;

export const text = (value: string): TextPart => ({ type: 'text', value });

/**
 * Link parts must be the only part in a message — they render as a rich preview and
 * the API rejects them alongside anything else.
 */
export const link = (value: string): LinkPart => ({ type: 'link', value });
