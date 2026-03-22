Now i want to add a feature "mode", which will be a "simulation mode", which will apply to all motion brush types (boid and ants currently), which will entail the ability to "set the parameters" of the simulation and the brush variables and then run the simulation to "paint" with the active agents, then be able to pause/stop via on screen controls.

UI for simulation should mirror that used for transform feature (flip hor, vert buttons, rotate buttons—the color and appearance) and other patterns as needed that are visually consistent with that. 

parameters selectable for all types: [spawn location, spreadradius, all stamp/rendering settings (in the usual UI locations)]

boids: [set "attraction" and repustion points, which should be click-and-draggable display as either a light orange (repusltion) or light deep blue (attraction) (and deletable with small transparent X superscript above right), "follow-path element", where a path could be drawn and the boids would be drawn to the simulated stroke along that path, with speed options]
