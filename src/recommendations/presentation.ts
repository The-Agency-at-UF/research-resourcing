import type { RecommendationRun } from './models.js';

export function managerMessage(run: RecommendationRun): string {
  const lines = [
    `Staffing recommendations: ${run.request.accountName}`,
    `${run.request.openings} opening(s), ${run.request.hoursPerResearcher} hours/week per researcher.`,
  ];
  if (run.status === 'no_eligible') lines.push('No eligible researcher. Review capacity, essential requirements, and data quality.');
  for (const r of run.displayed) lines.push(`${r.rank}. ${r.name} - fit score ${r.score.toFixed(1)}/100\n   ${r.explanation}`);
  for (const warning of run.warnings) lines.push(`Attention: ${warning}`);
  lines.push('Recommendations only. A department manager must approve selections and capacity must be rechecked before assignments are saved.');
  return lines.join('\n\n');
}
