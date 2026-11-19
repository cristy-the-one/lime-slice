import assert from "node:assert/strict";
import { isOpenMeshStep, meshStepOpenEdges } from "./mesh-step.ts";

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** Two triangles sharing one edge (#3), as a mesh converter writes them: five edges, four of them open. */
const facets = (extra = "") => `ISO-10303-21;
DATA;
#1 = PLANE('',#90);
#2 = EDGE_CURVE('',#80,#81,#70,.T.);
#3 = EDGE_CURVE('',#81,#82,#70,.T.);
#4 = EDGE_CURVE('',#82,#80,#70,.T.);
#5 = EDGE_CURVE('',#81,#83,#70,.T.);
#6 = EDGE_CURVE('',#83,#82,#70,.T.);
#10 = ORIENTED_EDGE('',*,*,#2,.T.);
#11 = ORIENTED_EDGE('',*,*,#3,.T.);
#12 = ORIENTED_EDGE('',*,*,#4,.T.);
#13 = ORIENTED_EDGE ( 'a (name) with #99 in it', *, *, #3, .F. ) ;
#14 = ORIENTED_EDGE('',*,*,#5,.T.);
#15 = ORIENTED_EDGE('',*,*,#6,.T.);
#20 = OPEN_SHELL('',(#30,#31));
#21 = SHELL_BASED_SURFACE_MODEL('',(#20));
${extra}ENDSEC;
END-ISO-10303-21;
`;

assert.equal(meshStepOpenEdges(bytes(facets())), 4);
assert.equal(isOpenMeshStep(bytes(facets())), true);

// Every edge run twice: a closed mesh, which Open CASCADE can still sew into a solid for Model.
const closed = facets().replace(/#1[0245] = ORIENTED_EDGE[^\n]*\n/g, "").replace("#11 =", "#16 = ORIENTED_EDGE('',*,*,#3,.F.);\n#11 =").replace(/#13 = [^\n]*\n/, "");
assert.equal(meshStepOpenEdges(bytes(closed)), 0);
assert.equal(isOpenMeshStep(bytes(closed)), false);

// A curved surface, a curved edge, or a solid: not a converted mesh, whatever else the file holds.
for (const line of ["#40 = CYLINDRICAL_SURFACE('',#90,5.);", "#40 = CIRCLE('',#90,5.);", "#40 = MANIFOLD_SOLID_BREP('',#20);", "#40 = B_SPLINE_CURVE_WITH_KNOTS('',3,(),.U.,.F.,.F.,(),(),.U.);", "#40 = SURFACE_OF_REVOLUTION('',#1,#2);"]) {
  assert.equal(meshStepOpenEdges(bytes(facets(`${line}\n`))), null, line);
}
// A name inside quoted text is not an entity.
assert.equal(meshStepOpenEdges(bytes(facets("#40 = PRODUCT('CIRCLE(1)','MANIFOLD_SOLID_BREP(',$,());\n"))), 4);
// No surface shells, or no flat face: an ordinary file.
assert.equal(meshStepOpenEdges(bytes(facets().replace("SHELL_BASED_SURFACE_MODEL", "SOMETHING_ELSE"))), null);
assert.equal(meshStepOpenEdges(bytes("ISO-10303-21;\nDATA;\nENDSEC;\n")), null);

console.log("mesh-step ok");
