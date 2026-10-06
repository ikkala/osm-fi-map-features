// Constants measured in Tampere, the city whose open data they could be measured from. They are used on
// purpose for every Finnish city, until there is data of another city's own to measure them from.

export interface MeasuredDefaults {
  /** People walking and cycling a day: base + scale × the draw of businesses and doors near the way */
  footfallModels: { walking: { base: number; scale: number }; cycling: { base: number; scale: number } };
  /** Vehicles a day on a road of a kind (highway=*), when nothing else is known */
  vehiclesByRoadKind: Record<string, number>;
  /** Meters between the staircases of a block of flats */
  stairSpacingM: number;
  /** A building of the register's offices-and-factories class with this many storeys or more is offices */
  officeLevels: number;
  /** Height of an untagged chimney: perWidth times its base's longest side, at most max meters */
  chimneyHeight: { perWidth: number; max: number };
  /** Wall material of an untagged chimney */
  chimneyMaterial: string;
  /** Buildings built before this year mostly have pitched roofs, later ones flat roofs */
  pitchedRoofsBefore: number;
  /** A roof whose top is at most this far over the eaves (m) is flat: its parapets, machine rooms and the like */
  flatRoofRiseM: number;
}

export const FINNISH_DEFAULTS_MEASURED_IN_TAMPERE: MeasuredDefaults = {
  // fitted to the city's pedestrian and cycling counts
  footfallModels: {
    walking: { base: 330, scale: 19.2 },
    cycling: { base: 330, scale: 0.5 },
  },
  // the city's motor traffic counts by the kind of road they are on
  vehiclesByRoadKind: {
    motorway: 30000,
    trunk: 20000,
    primary: 12000,
    secondary: 7000,
    tertiary: 3500,
    motorway_link: 6000,
    trunk_link: 4000,
    primary_link: 3000,
    secondary_link: 2000,
    tertiary_link: 1200,
    unclassified: 800,
    residential: 250,
    living_street: 60,
    service: 60,
  },
  // the staircases mapped in OSM
  stairSpacingM: 18,
  // the city's own building register, which tells offices from factories
  officeLevels: 4,
  // the chimneys with a height in OSM, and the old factory chimneys, which are brick
  chimneyHeight: { perWidth: 12, max: 100 },
  chimneyMaterial: "brick",
  // the city's 3D building parts: how far their tops rise over the storeys, by the decade they were built in
  pitchedRoofsBefore: 1960,
  flatRoofRiseM: 3,
};
