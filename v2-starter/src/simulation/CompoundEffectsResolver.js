/**
 * CompoundEffectsResolver — infers what happens when climate events stack.
 *
 * When a user adds a second (or third) event on top of an active simulation,
 * this resolver checks whether a known compound relationship exists between
 * the new event and any currently active event.
 *
 * If a match is found, a CompoundEffect is returned and surfaced in the chat
 * panel as an additional narrative layer — explaining how the events amplify
 * each other, what new risks emerge, and what the compounding means for the
 * affected population.
 *
 * Keys are alphabetically sorted event types joined by '+'.
 * Example: 'drought+wildfire' (not 'wildfire+drought').
 *
 * CompoundEffect shape:
 * {
 *   label:          string    — short name for the compound scenario
 *   narrative:      string    — explanation for the chat panel
 *   amplification:  Record<string, number>  — multipliers on risk metrics
 *   newRisks:       string[]  — hazards that only emerge from the combination
 *   chatPrompt:     string    — one-sentence insight surfaced in chat
 *   pairedWith:     string    — which active event triggered the match (set at runtime)
 * }
 */

/** @type {Record<string, Omit<CompoundEffect, 'pairedWith'>>} */
const COMPOUND_MAP = {

  // ── Seismic cascade ─────────────────────────────────────────────────────
  'earthquake+tsunami': {
    label: 'Seismic Cascade',
    narrative: 'Ground rupture displaces the ocean floor, generating a propagating wave. The earthquake disables port infrastructure and coastal evacuation routes before the wave arrives. Emergency services are overwhelmed by the ground event before the water arrives.',
    amplification: { displacement: 2.4, infrastructure_damage: 1.8, mortality_risk: 2.1 },
    newRisks: ['port_closure', 'aftershock_sequence', 'nuclear_facility_stress', 'evacuation_route_collapse'],
    chatPrompt: 'The earthquake collapsed evacuation infrastructure before the tsunami arrived — rescue windows that normally exist simply weren\'t there.',
  },

  // ── Flood + power ────────────────────────────────────────────────────────
  'power_grid_failure+tsunami': {
    label: 'Dark Flood',
    narrative: 'Saltwater intrusion disables coastal electrical substations. Emergency services, hospitals, and water treatment plants operate without grid power. Communication networks fail. The 2011 Tōhoku disaster demonstrated this exact cascade: the tsunami cut power to the Fukushima cooling systems within minutes.',
    amplification: { evacuation_difficulty: 3.1, medical_facility_failure: 2.6, rescue_delay: 2.0 },
    newRisks: ['water_treatment_failure', 'communication_blackout', 'cold_chain_collapse', 'fuel_shortage', 'nuclear_cooling_failure'],
    chatPrompt: 'With the grid down and floodwater rising, every system that depends on electricity — pumps, hospitals, 911 — fails simultaneously.',
  },

  'flood+power_grid_failure': {
    label: 'Grid-Down Flood',
    narrative: 'Floodwater reaches electrical infrastructure. Pump stations that normally drain inundation fail, accelerating depth. Traffic signals and emergency alert systems go dark. Residents cannot receive evacuation orders.',
    amplification: { inundation_depth: 1.4, evacuation_difficulty: 2.2, response_time: 1.8 },
    newRisks: ['sewage_overflow', 'pump_station_failure', 'traffic_grid_failure', 'emergency_alert_blackout'],
    chatPrompt: 'Flooding without power means pump stations can\'t drain water and residents can\'t receive alerts. The flood compounds at accelerating speed.',
  },

  // ── Fire weather ─────────────────────────────────────────────────────────
  'drought+wildfire': {
    label: 'Extreme Fire Weather',
    narrative: 'Prolonged drought desiccates vegetation to flashpoint. Fire spreads at rates that outpace suppression capacity. Soil moisture deficit prevents natural firebreaks from forming. Drought-conditioned fire is categorically different from wet-season fire: faster spread, deeper burn, and behavior that violates models built on historical conditions.',
    amplification: { fire_spread_rate: 2.8, suppression_effectiveness: 0.4, smoke_range: 2.1, reburn_probability: 1.9 },
    newRisks: ['ember_cast', 'watershed_contamination', 'post_fire_landslide', 'long_term_soil_loss'],
    chatPrompt: 'The Camp Fire (2018) and Australia\'s Black Summer (2019-20) both followed multi-year drought. Drought doesn\'t just dry things out — it changes how fire behaves entirely.',
  },

  'drought+locust_swarm': {
    label: 'Agricultural Collapse',
    narrative: 'Drought-stressed crops have zero resilience against locust pressure. A single swarm of 40 billion insects consumes food for 35,000 people per day. Food system failure follows within weeks across affected regions. The 2019–2020 East Africa crisis — worst in 70 years — arrived after two consecutive years of unusual rainfall.',
    amplification: { crop_loss: 3.4, food_security_impact: 2.9, migration_pressure: 2.2, economic_loss: 2.7 },
    newRisks: ['famine_risk', 'seed_stock_loss', 'regional_migration_surge', 'debt_spiral_for_smallholders'],
    chatPrompt: 'Drought conditions are what make locust swarms catastrophic rather than manageable. Without the drought, locusts are a problem. With it, they\'re a food system collapse.',
  },

  'compound_fire_weather+drought': {
    label: 'Critical Fire Conditions',
    narrative: 'The convergence of drought, heat, and wind creates conditions where fire behavior exceeds the design limits of every suppression system. Spotting distances — how far embers travel ahead of the fire front — can exceed 30 miles under these conditions.',
    amplification: { fire_spread_rate: 4.1, suppression_effectiveness: 0.2, evacuation_window: 0.3 },
    newRisks: ['mass_casualty_fire', 'town_scale_destruction', 'multi_front_fire'],
    chatPrompt: 'Under compound fire weather, fire behavior becomes effectively uncontrollable. Containment gives way to evacuation as the only viable strategy.',
  },

  // ── Heat ─────────────────────────────────────────────────────────────────
  'heatwave+power_grid_failure': {
    label: 'Thermal Blackout',
    narrative: 'Peak demand during extreme heat trips grid capacity. Cooling centers go offline. Vulnerable populations — elderly, unhoused, infants, dialysis patients — face survivability thresholds without mechanical cooling. The 2003 European heat wave killed over 70,000 people; the 2021 Pacific Northwest heat dome killed 1,400 in a week. Both happened before widespread air conditioning.',
    amplification: { mortality_risk: 4.2, hospital_capacity_strain: 2.8, medication_spoilage: 3.1 },
    newRisks: ['cooling_center_failure', 'insulin_and_vaccine_spoilage', 'heat_stroke_mass_casualty', 'dialysis_center_closure'],
    chatPrompt: 'Extreme heat without power is one of the most reliably deadly compound events in climate history. The death toll is invisible — it shows up as excess mortality weeks later.',
  },

  'heatwave+drought': {
    label: 'Compound Dry Heat',
    narrative: 'Drought removes soil moisture that normally moderates surface temperatures. Without evaporative cooling from the soil, surface temperatures exceed air temperatures by 10–20°F. Agricultural losses compound: crops that survived the drought die in the heat. Water bodies that shrank under drought reach lethal temperatures for fish.',
    amplification: { surface_temperature: 1.4, crop_loss: 2.1, freshwater_stress: 2.3 },
    newRisks: ['mass_fish_kill', 'crop_failure_acceleration', 'human_wet_bulb_exceedance'],
    chatPrompt: 'Drought and heat amplify each other through a feedback loop: less soil moisture → higher surface temps → more evaporation → less soil moisture.',
  },

  // ── Coastal ──────────────────────────────────────────────────────────────
  'hurricane+sea_level_rise': {
    label: 'Amplified Surge',
    narrative: 'Elevated baseline sea level adds directly to storm surge height. Storm tracks that historically spared inland areas now threaten them. Each centimeter of sea level rise adds directly to surge. By 2050 under SSP5-8.5, a Category 3 storm will inundate zones that only a Category 5 could reach today.',
    amplification: { surge_height: 1.6, inundation_extent: 2.1, property_damage: 1.9, displacement_duration: 1.7 },
    newRisks: ['permanent_coastal_retreat', 'freshwater_salinization', 'insurance_market_withdrawal'],
    chatPrompt: 'Sea level rise doesn\'t wait for storms. It raises the floor. When the hurricane arrives, it\'s starting from a higher baseline every year.',
  },

  'hurricane+storm_surge': {
    label: 'Compound Coastal Flood',
    narrative: 'Wind-driven surge combines with wave action. Surge arrives before peak wind, blocking evacuation routes that are still technically open. 90% of hurricane fatalities historically come from storm surge, not wind. Katrina\'s surge reached 28 feet in Mississippi — the wind was almost secondary.',
    amplification: { inundation_depth: 2.3, evacuation_window: 0.5, coastal_structure_damage: 2.1 },
    newRisks: ['bridge_overtopping', 'barrier_island_overwash', 'marina_destruction', 'saltwater_aquifer_intrusion'],
    chatPrompt: 'Storm surge is responsible for 90% of hurricane deaths. The flood arrives while wind is still building and roads are still nominally open — trapping people in place.',
  },

  'flood+sea_level_rise': {
    label: 'Permanent Tidal Flood Risk',
    narrative: 'Fluvial flooding (from rivers) and coastal flooding (from sea level rise) converge in low-lying delta and estuary regions. Land that drains after a flood event no longer fully drains when the sea level baseline has risen. Chronic inundation replaces episodic flooding.',
    amplification: { drainage_capacity: 0.6, flood_frequency: 2.8, permanent_loss_probability: 1.9 },
    newRisks: ['chronic_inundation', 'delta_subsidence', 'saltwater_soil_damage'],
    chatPrompt: 'Where sea level rise meets river systems, episodic flooding becomes chronic. What was once a 100-year flood becomes a seasonal event.',
  },

  // ── Infrastructure cascade ────────────────────────────────────────────────
  'flood+infrastructure_cascade': {
    label: 'System Cascade',
    narrative: 'Floodwater disables multiple interdependent systems simultaneously. Power → water treatment → medical supply chain → fuel delivery. Each failure accelerates the others. The Houston freeze of 2021 showed this mechanism clearly: power failed, then water froze, then hospitals lost backup power, then fuel supply chains stalled — 200+ deaths from cold in the most energy-producing state in the country.',
    amplification: { recovery_time: 3.1, affected_population: 1.8, economic_disruption: 2.4 },
    newRisks: ['hospital_generator_failure', 'dialysis_center_closure', 'fuel_depot_contamination', 'supply_chain_rupture'],
    chatPrompt: 'Infrastructure systems are designed with single-failure assumptions. Compound events break the assumption. The cascade happens faster than response systems can adapt.',
  },

  'power_grid_failure+infrastructure_cascade': {
    label: 'Total System Failure',
    narrative: 'Grid failure is the domino that knocks down all others. Modern water treatment, sewage, emergency communications, hospital operations, traffic management, and fuel delivery all assume continuous electricity. When the grid goes down in a disaster context, every system fails in rapid succession.',
    amplification: { recovery_time: 4.2, critical_service_failure: 3.6 },
    newRisks: ['sewage_system_failure', 'hospital_generator_exhaustion', 'communications_blackout', 'potable_water_crisis'],
    chatPrompt: 'Every critical infrastructure system in a modern city is a grid-dependent system. Grid failure doesn\'t just turn off lights — it turns off civilization.',
  },

  // ── Conflict + climate ────────────────────────────────────────────────────
  'conflict+flood': {
    label: 'Crisis Compounding',
    narrative: 'Active conflict prevents pre-positioning of emergency supplies and blocks international disaster response. Displaced populations have no safe shelter to evacuate to. Infrastructure damage from conflict removes natural flood protections like levees and drainage systems. Gaza, Yemen, Sudan, and South Sudan all face this compound in real time.',
    amplification: { mortality_risk: 3.8, displacement_duration: 2.6, aid_delivery_failure: 4.1, disease_outbreak_risk: 2.9 },
    newRisks: ['disease_outbreak', 'water_contamination', 'humanitarian_access_denial', 'dual_displacement'],
    chatPrompt: 'Climate disasters in active conflict zones are categorically worse. The systems that respond to disasters don\'t exist or can\'t access the affected population.',
  },

  'conflict+heatwave': {
    label: 'Survivability Crisis',
    narrative: 'Conflict destroys water infrastructure and power supply that keep people alive during extreme heat. Without running water or electricity, wet-bulb survivability thresholds are reached faster. Medical systems cannot absorb heat-stroke caseloads. The combination of unrelenting heat and no access to cooling is among the most acutely lethal climate-conflict compound scenarios.',
    amplification: { mortality_risk: 4.6, water_access_failure: 3.2, heat_casualty_rate: 3.8 },
    newRisks: ['wet_bulb_exceedance', 'mass_casualty_event', 'dehydration_crisis'],
    chatPrompt: 'In conflict zones, the infrastructure that normally keeps people alive during heat events has already been destroyed. There is no fallback.',
  },

  'conflict+drought': {
    label: 'Water-Conflict Spiral',
    narrative: 'Water scarcity under drought conditions intensifies competition for remaining resources, escalating existing conflict or triggering new ones. The Syrian civil war (2011) was preceded by the worst drought in 900 years (2006–2010), which drove 1.5 million rural Syrians into cities. Climate-conflict feedback loops are well-documented in the Sahel, Horn of Africa, and Middle East.',
    amplification: { displacement: 2.9, conflict_intensity: 1.7, famine_risk: 2.4 },
    newRisks: ['resource_conflict_escalation', 'mass_rural_displacement', 'urban_pressure_spike'],
    chatPrompt: 'The link between drought and conflict is well established. Water scarcity doesn\'t cause conflict on its own — it amplifies underlying pressures until something breaks.',
  },

  // ── Volcanic ──────────────────────────────────────────────────────────────
  'heatwave+volcanic_eruption': {
    label: 'Atmospheric Stress',
    narrative: 'During a heat wave, the standard guidance is to open windows. Volcanic ash in the air makes that guidance lethal. Residents face contradictory survival instructions. The sulfur dioxide emitted by eruptions causes immediate respiratory crises — particularly severe when heat prevents sealing homes.',
    amplification: { respiratory_risk: 2.8, indoor_heat_risk: 1.6, evacuation_complexity: 2.1 },
    newRisks: ['contradictory_guidance_failure', 'air_filter_shortage', 'evacuation_route_ash_cover'],
    chatPrompt: 'Volcanic eruption during a heat wave creates two survival instructions that directly contradict each other. There is no good option.',
  },

  'flood+volcanic_eruption': {
    label: 'Lahar Risk',
    narrative: 'Volcanic ash deposits on slopes become catastrophically unstable when saturated by heavy rain or flooding. Lahars — volcanic mudflows — move faster than lava and can travel 60+ miles from the vent. Eruption debris destabilizes entire watersheds for years after the initial event.',
    amplification: { landslide_risk: 3.4, downstream_flood_risk: 2.6, infrastructure_burial: 2.1 },
    newRisks: ['lahar_flow', 'pyroclastic_density_current', 'long_term_watershed_instability'],
    chatPrompt: 'Lahars are more dangerous than lava for most populations. Ash + water = concrete moving at highway speed. Mount Pinatubo\'s lahars killed more people than the eruption itself.',
  },

  // ── Epidemic + climate ────────────────────────────────────────────────────
  'flood+epidemic_outbreak': {
    label: 'Contamination Cascade',
    narrative: 'Floodwater overwhelms sewage systems, contaminating drinking water supplies with pathogens. Cholera, typhoid, and hepatitis A spread through the post-flood water supply. Stagnant water creates ideal breeding conditions for malaria and dengue vectors. The combination of flood and disease is the most common post-disaster mortality multiplier in the Global South.',
    amplification: { disease_transmission: 3.2, mortality_risk: 2.1, healthcare_system_load: 2.8 },
    newRisks: ['cholera_outbreak', 'dengue_surge', 'malaria_spike', 'diarrheal_disease_epidemic'],
    chatPrompt: 'Most flood deaths don\'t happen during the flood. They happen in the weeks after, from waterborne disease. The flood is the vector; disease is the killer.',
  },

  'heatwave+epidemic_outbreak': {
    label: 'Compound Health Crisis',
    narrative: 'Heat exhaustion and heat stroke overwhelm hospital systems. When epidemic disease hits simultaneously, triage capacity collapses. Staff working in extreme heat face their own heat-related illness. The 2022 Pakistan floods combined flooding, heat, and cholera — a preview of compound health crises at scale.',
    amplification: { hospital_capacity_failure: 3.1, mortality_risk: 2.6, healthcare_worker_attrition: 1.8 },
    newRisks: ['triage_collapse', 'healthcare_worker_heat_illness', 'medication_shortage'],
    chatPrompt: 'Two health crises hitting simultaneously don\'t add — they multiply. Hospital capacity designed for one emergency has no slack for a second.',
  },
};

export class CompoundEffectsResolver {
  /**
   * @param {string[]} activeEvents — event types currently in the simulation stack
   * @param {string} incomingEvent  — new event type being added
   * @returns {CompoundEffect | null}
   */
  resolve(activeEvents, incomingEvent) {
    if (!incomingEvent || !activeEvents?.length) return null;

    // Check each active event against the incoming event
    for (const active of activeEvents) {
      if (!active) continue;
      const key = [active, incomingEvent].sort().join('+');
      if (COMPOUND_MAP[key]) {
        return { ...COMPOUND_MAP[key], pairedWith: active };
      }
    }

    // No direct pair found — check for triple compound
    if (activeEvents.length >= 2) {
      const tripleKey = [...activeEvents, incomingEvent].sort().join('+');
      if (COMPOUND_MAP[tripleKey]) {
        return { ...COMPOUND_MAP[tripleKey], pairedWith: activeEvents };
      }
    }

    // No compound relationship defined for this combination
    return null;
  }

  /** @returns {string[]} all registered compound pair keys */
  get registeredPairs() {
    return Object.keys(COMPOUND_MAP);
  }

  /** @returns {number} */
  get pairCount() {
    return Object.keys(COMPOUND_MAP).length;
  }
}

/**
 * @typedef {Object} CompoundEffect
 * @property {string} label
 * @property {string} narrative
 * @property {Record<string, number>} amplification
 * @property {string[]} newRisks
 * @property {string} chatPrompt
 * @property {string | string[]} pairedWith  — set at runtime by resolve()
 */
