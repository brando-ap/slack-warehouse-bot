// Photo attachments. Images are never stored in our database — Slack hosts
// them. Files uploaded through the /request form are private to the uploader,
// so the bot re-uploads each one into the ticket's channel thread (making it
// visible to the whole team) and saves only tiny JSON references.

import * as db from './db';
import { slackApi, slackApiForm } from './slack';

export interface ModalFile {
  id: string;
  name?: string;
  title?: string;
  size?: number;
  url_private?: string;
  mimetype?: string;
}

export interface PhotoRef {
  id: string;
  permalink?: string;
}

const MAX_PHOTOS = 5;
const MAX_BYTES = 20 * 1024 * 1024; // skip anything over 20 MB

/** How many photos a request has, from its stored JSON refs. */
export function photoCount(photosJson: string | null): number {
  if (!photosJson) return 0;
  try {
    const parsed = JSON.parse(photosJson);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Re-share modal-uploaded files into the ticket's thread and record their
 * references. Returns how many were attached successfully.
 */
export async function attachPhotos(
  env: Env,
  requestId: number,
  files: ModalFile[],
  channelId: string,
  threadTs: string
): Promise<number> {
  const saved: PhotoRef[] = [];

  for (const file of files.slice(0, MAX_PHOTOS)) {
    try {
      if (!file.url_private || !file.size || file.size > MAX_BYTES) continue;
      const filename = file.name ?? file.title ?? 'photo';

      // 1. Ask Slack for an upload slot
      const slot = await slackApiForm(env, 'files.getUploadURLExternal', {
        filename,
        length: String(file.size),
      });
      const uploadUrl = slot.upload_url;
      const newFileId = slot.file_id;
      if (!slot.ok || typeof uploadUrl !== 'string' || typeof newFileId !== 'string') continue;

      // 2. Download the private original (bot token), then push it to the slot
      const src = await fetch(file.url_private, {
        headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      });
      if (!src.ok) continue;
      const bytes = await src.arrayBuffer();
      const up = await fetch(uploadUrl, { method: 'POST', body: bytes });
      await up.text();
      if (!up.ok) continue;

      // 3. Finish the upload, sharing straight into the ticket's thread
      const complete = await slackApi(env, 'files.completeUploadExternal', {
        files: [{ id: newFileId, title: filename }],
        channel_id: channelId,
        thread_ts: threadTs,
      });
      if (complete.ok) {
        const shared = (complete.files as Array<{ id: string; permalink?: string }> | undefined)?.[0];
        saved.push({ id: shared?.id ?? newFileId, permalink: shared?.permalink });
      }
    } catch (err) {
      console.log(
        JSON.stringify({ level: 'error', event: 'photo_attach_failed', file: file.id, error: String(err) })
      );
    }
  }

  if (saved.length > 0) {
    await db.setRequestPhotos(env, requestId, JSON.stringify(saved));
  }
  return saved.length;
}
