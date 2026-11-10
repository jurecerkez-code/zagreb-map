// Rank tone-candidate captures against the exact #24 rule. A candidate names home-, near- and far-<name> keys.
import { readFileSync } from 'node:fs';

const [baselinePath = 'shots/pre24-fixed/metrics.json', candidatesPath = 'shots/tone-fixed1280-results.json'] = process.argv.slice(2);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const captures = JSON.parse(readFileSync(candidatesPath, 'utf8'));
const names = new Set(Object.keys(captures).map(key => key.replace(/^(home|near|far)-/, '')));
const rank = [...names].map(name => {
  const views = Object.entries(baseline).map(([view, base]) => {
    const shot = captures[`${view}-${name}`];
    if (!shot) return { view, present: false };
    const ratio = shot.mean / base.mean;
    return { view, present: true, mean: shot.mean, stddev: shot.stddev, ratio,
      meanOk: ratio >= 1 && ratio <= 1.25, contrastOk: shot.stddev >= base.stddev };
  });
  const numbers = views.filter(v => v.present);
  return {
    name,
    pass: views.every(v => v.present && v.meanOk && v.contrastOk),
    complete: views.every(v => v.present),
    meanRatios: Object.fromEntries(numbers.map(v => [v.view, +v.ratio.toFixed(3)])),
    contrasts: Object.fromEntries(numbers.map(v => [v.view, +v.stddev.toFixed(2)])),
  };
});
rank.sort((a, b) => Number(b.pass) - Number(a.pass) || Number(b.complete) - Number(a.complete) || a.name.localeCompare(b.name));
console.table(rank.map(({ name, pass, complete, meanRatios, contrasts }) => ({
  name, pass, complete,
  homeRatio: meanRatios.home, nearRatio: meanRatios.near, farRatio: meanRatios.far,
  homeContrast: contrasts.home, nearContrast: contrasts.near, farContrast: contrasts.far,
})));
if (!rank.every(r => r.complete)) process.exitCode = 2;
else if (!rank.some(r => r.pass)) process.exitCode = 1;
