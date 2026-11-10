export const YEAR_ISSUE_REPO = 'jurecerkez-code/zagreb-map';

// GitHub owns the submission/review transport. The card sends the user to its public issue form,
// not to a retired Worker endpoint or to a guessed replacements API.
export function yearIssueUrl(gid, address = '') {
  const id = String(gid ?? '');
  if (!/^(?:0|[1-9]\d*)$/.test(id)) return null;
  const q = new URLSearchParams({ template: 'year.yml', title: `[year] gid ${id}`, gid: id, address: String(address ?? ''),
    labels: 'contributions,needs-human' });
  return `https://github.com/${YEAR_ISSUE_REPO}/issues/new?${q.toString()}`;
}
