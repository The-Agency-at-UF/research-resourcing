import {
  configSchema, criteria, requestSchema, researcherSchema,
  type Breakdown, type Criterion, type Recommendation, type RecommendationRun,
} from './models.js';

/** Pure ranking function: no assignments, writes, network calls, or generated facts. */
export function recommend(rawResearchers: unknown[], rawRequest: unknown, rawConfig: unknown): RecommendationRun {
  const request = requestSchema.parse(rawRequest);
  const config = configSchema.parse(rawConfig);
  const excluded: RecommendationRun['excluded'] = [];
  const candidates: Recommendation[] = [];
  const idCounts = new Map<string, number>();
  for (const raw of rawResearchers) {
    const id = raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' ? raw.id.trim() : undefined;
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  rawResearchers.forEach((raw, index) => {
    const parsed = researcherSchema.safeParse(raw);
    const rawId = raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' ? raw.id.trim() : '';
    if (rawId && (idCounts.get(rawId) ?? 0) > 1) {
      excluded.push({ researcherId: rawId, reasons: ['Conflicting duplicate researcher ID'], dataIssue: true });
      return;
    }
    if (!parsed.success) {
      excluded.push({
        researcherId: rawId || `row-${index + 1}`,
        reasons: parsed.error.issues.map(i => `${i.path.join('.') || 'record'}: ${i.message}`), dataIssue: true,
      });
      return;
    }
    const r = parsed.data;
    const remainingHours = r.weeklyCapacityHours - r.committedHours;
    const reasons: string[] = [];
    if (!r.active) reasons.push('Researcher is inactive');
    if (remainingHours < request.hoursPerResearcher) reasons.push(`Only ${remainingHours} hours available; ${request.hoursPerResearcher} required`);
    if (r.currentAccountIds.includes(request.accountId)) reasons.push('Already assigned to this account; additional hours require a separate workflow');
    if (r.currentAccountIds.length >= r.maxAccounts) reasons.push('Maximum account load reached');
    const missing = request.requiredSkills.filter(s => !r.skills.includes(s));
    if (missing.length) reasons.push(`Missing essential skills: ${missing.join(', ')}`);
    if (r.experienceYears < request.minimumExperienceYears) reasons.push(`Minimum experience is ${request.minimumExperienceYears} years`);
    if (reasons.length) {
      excluded.push({ researcherId: r.id, reasons, dataIssue: false });
      return;
    }

    const desiredSkills = request.preferredSkills.length ? request.preferredSkills : request.requiredSkills;
    const matchedSkills = [...new Set([...request.requiredSkills, ...request.preferredSkills])].filter(s => r.skills.includes(s));
    const matchedInterests = request.careerInterests.filter(s => r.interests.includes(s));
    const values: Record<Criterion, number | null> = {
      bandwidth: remainingHours / r.weeklyCapacityHours,
      skills: desiredSkills.length ? desiredSkills.filter(s => r.skills.includes(s)).length / desiredSkills.length : null,
      experience: Math.min(r.experienceYears / config.experienceReferenceYears, 1),
      interests: request.careerInterests.length ? matchedInterests.length / request.careerInterests.length : null,
      accountLoad: 1 - r.currentAccountIds.length / r.maxAccounts,
      industry: request.industryId ? Number(r.industryExperienceIds.includes(request.industryId)) : null,
    };
    const activeWeight = criteria.reduce((sum, k) => sum + (values[k] === null ? 0 : config.weights[k]), 0);
    const breakdown = Object.fromEntries(criteria.map(k => {
      const effectiveWeight = values[k] === null ? 0 : config.weights[k] / activeWeight;
      return [k, { value: values[k], effectiveWeight, contribution: (values[k] ?? 0) * effectiveWeight }];
    })) as Breakdown;
    const score = 100 * criteria.reduce((sum, k) => sum + breakdown[k].contribution, 0);
    const facts = [
      `${remainingHours} hours/week available; request needs ${request.hoursPerResearcher}`,
      `${remainingHours - request.hoursPerResearcher} hours/week would remain`,
      request.requiredSkills.length ? `meets all essential skills (${request.requiredSkills.join(', ')})` : 'no essential skills specified',
      `${r.experienceYears} years of experience`,
      `${r.currentAccountIds.length}/${r.maxAccounts} account slots currently used`,
    ];
    if (request.preferredSkills.length) facts.push(`${request.preferredSkills.filter(s => r.skills.includes(s)).length}/${request.preferredSkills.length} preferred skills matched`);
    if (request.careerInterests.length) facts.push(`${matchedInterests.length}/${request.careerInterests.length} interests matched`);
    if (request.industryId) facts.push(r.industryExperienceIds.includes(request.industryId) ? `experience in ${request.industryId}` : `no listed experience in ${request.industryId}`);
    candidates.push({ researcherId: r.id, name: r.name, rank: 0, score, remainingHours,
      hoursAfterAssignment: remainingHours - request.hoursPerResearcher, matchedSkills, matchedInterests,
      explanation: facts.join('; ') + '.', breakdown });
  });

  // Full precision for sorting; stable ID ordering makes ties repeatable.
  candidates.sort((a, b) => b.score - a.score || (a.researcherId < b.researcherId ? -1 : a.researcherId > b.researcherId ? 1 : 0));
  const retained = candidates.slice(0, config.retainCount).map((r, index) => ({ ...r, rank: index + 1 }));
  const warnings: string[] = [];
  if (excluded.some(r => r.dataIssue)) warnings.push('Some researcher records are incomplete or conflicting; manager review is required.');
  if (candidates.length < request.openings) warnings.push(`Only ${candidates.length} eligible researchers for ${request.openings} openings.`);
  if (request.openings > 1) warnings.push('Openings share the same requirements and shortlist. A researcher can fill only one opening; this run does not assign anyone.');
  if (request.openings > config.retainCount) warnings.push('The retained shortlist is limited to five; rerun after approved assignments to staff additional openings.');
  return { request, config, status: candidates.length === 0 ? 'no_eligible' : candidates.length < request.openings ? 'partial' : 'ready',
    eligibleCount: candidates.length, retained, displayed: retained.slice(0, config.displayCount), excluded, warnings };
}
