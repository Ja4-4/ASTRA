import type { SystemId } from './systems';

export interface Source { cite: string; url: string }
export interface EvidenceEntry { system: SystemId | 'radiation'; title: string; why: string; indicators: string; ruleBasis: string; sources: Source[] }

/**
 * Citation check status: PENDING RESEARCH PARTNER. Each reference below must be verified against the
 * original before judging. Rules are demo thresholds, not clinical criteria.
 */
export const EVIDENCE: EvidenceEntry[] = [
  {
    system: 'cardio', title: 'Heart & blood flow',
    why: 'Without gravity, body fluids move up toward the head and the heart does less work, so it can get weaker. Long missions also change the blood vessels. NASA lists this as an official astronaut health risk.',
    indicators: 'Resting heart rate, blood pressure',
    ruleBasis: 'Blood pressure limits loosely follow the 2017 American heart guidelines (ACC/AHA): 130 top or 80 bottom counts as raised. Heart rate uses a normal adult resting range, plus a check against your own usual (15% either way).',
    sources: [
      { cite: 'NASA Human Research Program. Human Research Roadmap: Risk of cardiovascular adaptations contributing to adverse mission performance and health outcomes.', url: 'https://humanresearchroadmap.nasa.gov/' },
      { cite: 'Whelton PK, et al. 2017 ACC/AHA Guideline for the Prevention, Detection, Evaluation, and Management of High Blood Pressure in Adults. Hypertension. 2018;71:e13–e115.', url: 'https://doi.org/10.1161/HYP.0000000000000065' },
    ],
  },
  {
    system: 'neuro', title: 'Sleep & mood',
    why: 'A small crew, tight spaces and about 16 sunrises a day make it hard to sleep and stay in a good mood. Short sleep is common in space and is often the first sign something is off.',
    indicators: 'Sleep hours, mood (1–5 self-report)',
    ruleBasis: '7 hours is the usual adult sleep advice. ASTRA also compares with your own usual and looks for several bad nights in a row, not one.',
    sources: [
      { cite: 'Barger LK, et al. Prevalence of sleep deficiency and use of hypnotics in astronauts before, during, and after spaceflight: an observational study. Lancet Neurol. 2014;13(9):904–912.', url: 'https://doi.org/10.1016/S1474-4422(14)70122-X' },
      { cite: 'NASA Human Research Program. Human Research Roadmap: Risk of adverse cognitive or behavioral conditions and psychiatric disorders.', url: 'https://humanresearchroadmap.nasa.gov/' },
    ],
  },
  {
    system: 'metabolic', title: 'Blood sugar',
    why: 'Spaceflight changes how the body handles sugar from food, and the menu in space is limited.',
    indicators: 'Fasting blood glucose',
    ruleBasis: 'Limits loosely follow the American Diabetes Association: under 70 is low, under 54 is very low, and 126 or more before breakfast is above the usual range.',
    sources: [
      { cite: 'American Diabetes Association. Standards of Care in Diabetes (current edition), sections on glycemic targets and hypoglycemia classification.', url: 'https://diabetesjournals.org/care' },
      { cite: 'Garrett-Bakelman FE, et al. The NASA Twins Study: a multidimensional analysis of a year-long human spaceflight. Science. 2019;364(6436):eaau8650.', url: 'https://doi.org/10.1126/science.aau8650' },
    ],
  },
  {
    system: 'immune', title: 'Temperature & immunity',
    why: 'The immune system gets weaker in space, and body temperature runs a little higher than on Earth. So a textbook fever number can mislead. ASTRA compares you with your own usual, plus one fixed fever limit.',
    indicators: 'Body temperature',
    ruleBasis: 'Within half a degree of your usual is in range. 38.5 °C or more is always Act now.',
    sources: [
      { cite: 'Stahn AC, et al. Increased core body temperature in astronauts during long-duration space missions. Sci Rep. 2017;7:16180.', url: 'https://doi.org/10.1038/s41598-017-15560-w' },
      { cite: 'Garrett-Bakelman FE, et al. The NASA Twins Study. Science. 2019;364(6436):eaau8650.', url: 'https://doi.org/10.1126/science.aau8650' },
    ],
  },
  {
    system: 'msk', title: 'Muscles & bones (based on exercise done)',
    why: 'Without gravity, bones and muscles shrink. Daily weight training and cardio slow this down. ASTRA cannot scan bones, so it tracks whether you did your planned exercise.',
    indicators: 'Exercise done: minutes finished ÷ minutes planned, over the last 7 days',
    ruleBasis: '85% or more of the plan is in range. Doing more than planned earns nothing extra.',
    sources: [
      { cite: 'LeBlanc A, et al. Bone mineral and lean tissue loss after long duration space flight. J Musculoskelet Neuronal Interact. 2000;1(2):157–160.', url: 'https://www.ismni.org/jmni/' },
      { cite: 'NASA Human Research Program. Human Research Roadmap: Risk of bone fracture due to spaceflight-induced changes to bone.', url: 'https://humanresearchroadmap.nasa.gov/' },
    ],
  },
  {
    system: 'ocular', title: 'Eyes (not tracked yet)',
    why: 'On long missions, pressure changes can alter the back of the eye and eyesight (called SANS). An eyesight self-check is planned. Until then this stays grey.',
    indicators: 'Eyesight self-check (planned)',
    ruleBasis: 'No limit used in this demo.',
    sources: [
      { cite: 'Lee AG, et al. Spaceflight associated neuro-ocular syndrome (SANS) and the neuro-ophthalmologic effects of microgravity: a review and an update. NPJ Microgravity. 2020;6:7.', url: 'https://doi.org/10.1038/s41526-020-0097-9' },
    ],
  },
  {
    system: 'radiation', title: 'Radiation (for information)',
    why: 'In space, crews take in radiation from the Sun and deep space. ASTRA shows the running total for information only and never turns it into a health colour.',
    indicators: 'Total dose in mSv (made-up in this demo)',
    ruleBasis: 'No alert. Display only.',
    sources: [
      { cite: 'NASA Human Research Program. Human Research Roadmap: Risk of space radiation exposure.', url: 'https://humanresearchroadmap.nasa.gov/' },
    ],
  },
];
