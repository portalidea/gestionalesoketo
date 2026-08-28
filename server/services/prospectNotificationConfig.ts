export function getProspectNotificationRecipient(env: NodeJS.ProcessEnv = process.env): string {
  const recipient = env.PROSPECT_NOTIFICATION_TO?.trim();
  if (!recipient) {
    throw new Error("PROSPECT_NOTIFICATION_TO non è configurata");
  }
  return recipient;
}
