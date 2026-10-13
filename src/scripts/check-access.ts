const groups: Record<string, string[]> = {
  'Gemini explanations (optional)': ['GEMINI_API_KEY'],
  'Slack local demo': ['SLACK_TEAM_ID', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  'Microsoft delegated sign-in': ['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID'],
  'Microsoft workbook mapping': ['MICROSOFT_DRIVE_ID', 'MICROSOFT_RESEARCHERS_ITEM_ID', 'MICROSOFT_ACCOUNTS_ITEM_ID'],
  'AWS project profile': ['AWS_PROFILE', 'AWS_REGION'],
  'DynamoDB recommendation storage': ['RECOMMENDATION_RUNS_TABLE', 'RECOMMENDATION_RESULTS_TABLE'],
};
console.log('Configuration presence only. This does not verify permissions or send network requests.');
for (const [label, fields] of Object.entries(groups)) {
  const missing = fields.filter(key => !process.env[key]?.trim());
  console.log(`${label}: ${missing.length ? `missing ${missing.join(', ')}` : 'configured; verify service access next'}`);
}
