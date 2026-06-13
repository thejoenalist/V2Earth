/**
 * WorldStateAnalytics — ported from V1. Logic unchanged, schema preserved.
 *
 * Produces structured, queryable analytics from synthesized world state.
 * Stateless: call buildAnalytics on every tick or on demand.
 *
 * Consumed by: CountryPanel, TelemetryService, NarrativeEngine, AdminDashboard
 */

/**
 * @param {{
 *   regionalMetrics: Map<string, RegionalMetrics>,
 *   globalIndicators: GlobalIndicators,
 *   cascadeConsequences: Record<string, number>,
 *   prevGlobalIndicators?: GlobalIndicators | null,
 * }} inputs
 */
export function buildWorldStateAnalytics(inputs) {
  const { regionalMetrics, globalIndicators, cascadeConsequences, prevGlobalIndicators } = inputs;
  const regions = Array.from(regionalMetrics.entries());

  const highestInstability = regions
    .map(([iso, m]) => ({ iso, score: m.systemicStress }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const strongestAdaptation = regions
    .map(([iso, m]) => ({ iso, score: m.adaptationMomentum, resilience: m.resilienceScore }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const fastestDeteriorating = prevGlobalIndicators
    ? _buildDeterioratingList(prevGlobalIndicators, globalIndicators)
    : [];

  const strongestStressors = _buildStressorList(globalIndicators);

  const migrationHotspots = regions
    .filter(([, m]) => m.migrationPressure >= 0.5)
    .map(([iso, m]) => ({ iso, migrationPressure: m.migrationPressure, governanceStrain: m.governanceStrain }))
    .sort((a, b) => b.migrationPressure - a.migrationPressure)
    .slice(0, 6);

  const blackoutClusters = regions
    .filter(([, m]) => m.blackoutRisk >= 0.45)
    .map(([iso, m]) => ({ iso, blackoutRisk: m.blackoutRisk, infrastructureFragility: m.infrastructureFragility }))
    .sort((a, b) => b.blackoutRisk - a.blackoutRisk)
    .slice(0, 6);

  const foodStressZones = regions
    .filter(([, m]) => m.foodRisk >= 0.50)
    .map(([iso, m]) => ({ iso, foodRisk: m.foodRisk, migrationPressure: m.migrationPressure }))
    .sort((a, b) => b.foodRisk - a.foodRisk)
    .slice(0, 6);

  return {
    highestInstability,
    strongestAdaptation,
    fastestDeteriorating,
    strongestStressors,
    migrationHotspots,
    blackoutClusters,
    foodStressZones,
    cascadeSummary: { ...cascadeConsequences },
  };
}

function _buildStressorList(indicators) {
  const stressMap = {
    'Food System':          1 - (indicators.globalFoodStability       ?? 1),
    'Shipping / Logistics': 1 - (indicators.globalShippingStability   ?? 1),
    'Semiconductor Supply': 1 - (indicators.semiconductorAvailability ?? 1),
    'Insurance Markets':    1 - (indicators.insuranceMarketStability  ?? 1),
    'Power Grid':           1 - (indicators.gridStability             ?? 1),
    'Water Security':       1 - (indicators.waterSecurity             ?? 1),
    'Climate Stress':       indicators.globalClimateStress            ?? 0,
    'Migration Pressure':   indicators.globalMigrationPressure        ?? 0,
    'Commodity Volatility': indicators.commodityVolatility            ?? 0,
  };
  return Object.entries(stressMap)
    .map(([label, stress]) => ({ label, stress: Number(stress.toFixed(3)) }))
    .sort((a, b) => b.stress - a.stress);
}

function _buildDeterioratingList(prev, next) {
  const result = [];
  for (const [k, nextVal] of Object.entries(next)) {
    const prevVal = prev[k] ?? nextVal;
    const delta = nextVal - prevVal;
    if (delta < 0) {
      result.push({ indicator: k, delta: Number(delta.toFixed(3)), rate: Math.abs(delta) });
    }
  }
  return result.sort((a, b) => b.rate - a.rate).slice(0, 5);
}

/**
 * @typedef {{ systemicStress: number, adaptationMomentum: number, resilienceScore: number,
 *   migrationPressure: number, governanceStrain: number, blackoutRisk: number,
 *   infrastructureFragility: number, foodRisk: number }} RegionalMetrics
 *
 * @typedef {{ globalFoodStability: number, globalShippingStability: number,
 *   semiconductorAvailability: number, insuranceMarketStability: number,
 *   gridStability: number, waterSecurity: number, globalClimateStress: number,
 *   globalMigrationPressure: number, commodityVolatility: number }} GlobalIndicators
 */
