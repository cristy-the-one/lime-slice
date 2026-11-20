# Plan: natural frequencies and buckling loads

Status: study only. No feature code. Written 2026-11-19 against `feature/ribs-next` at 5eb46437 (the A panel merge, v6.11.0). The measurements are on `ribs-next/b-probe` at 3b5680ab. That branch is pushed for review and is not to be merged: it adds one integration test, `crates/lime-sim/tests/shell_modes_probe.rs`, and does not change `crates/lime-sim/src`. This document is the only change on the branch that is merged.

The question, from the handover §4 B: can the shell solver give natural frequencies and buckling loads, and can the rib planner aim at them?

Evidence marks: **[probe]** measured on this machine with `cargo test -p lime-sim --release --test shell_modes_probe -- --nocapture`, one thread, synthetic plates only; **[read]** the source and faer 0.24.4.

Material throughout: E = 2000 MPa, ν = 0.3. Density ρ = 10⁻⁹ N·s²/mm⁴, which is 1 g/cm³ in millimetres and newtons. Units mm, N, MPa. D = E h³ / (12 (1−ν²)). The shell is the Allman membrane plus the discrete Kirchhoff triangle, drilling penalty α = 0.01, six dofs per node `[ux, uy, uz, θx, θy, θz]`, and one web rotation ψ per rib vertex. ω is rad/s. A frequency in Hz is ω / 2π.

## The short answer

Yes for both analyses, on the solver that is already there. Vibration first, buckling second, which is the handover's order. The package stays an L. The vibration slice is a mass matrix, one eigen solve, and a change to the greedy score. The buckling slice is the plate geometric stiffness on top of the same eigen solve.

Each question, with the number from the probe:

1. Use a consistent translational mass on u, v, w. Put no rotary mass on the drilling dof, and no rotary mass on ψ beyond what the rib's offset kinematics already carry. At the 32×16 plate the consistent and lumped ω₁ differ by 0.40%, and both are inside 2% of the closed form. A physical drilling mass moves ω₁ by 0.005%. A physical ψ inertia moves it by less than the printed digit. A 10⁶× drilling mass, and a 10⁴× ψ mass, move the lowest mode by 42% and 64% and take it out of bending.
2. Plate buckling needs the DKT geometric stiffness from the membrane forces Nxx, Nyy, Nxy acting on the slopes β. At 32×32 that load is 0.013% under 4π²D/b². Adding the membrane geometric stiffness does not change a printed digit. The beam's geometric stiffness, checked on its own, is 0.022% under Euler.
3. faer 0.24.4 has no sparse generalized eigensolver. `matrix_free::eigen::partial_eigen` is Krylov–Schur for the eigenvalues of largest magnitude, and K⁻¹S through the existing LDLᵀ turns the lowest modes into those. On a 120×70 panel at the planner tests' 5 mm pitch (1794 dofs) one eigen solve is 0.009 s against a static solve of 0.002 s. At 6240 dofs it is 0.151 s against 0.010 s.
4. On a square plate the single-vector score of a repeated pair swings by a factor of 126 across the subspace. The vector the solver returns scores the rib 63× above the direction that stays the lower mode. The fix is the lower eigenvalue of the projected 2×2. The sum of the cluster is the large one, and would credit a rib that sits on a node line.
5. The greedy score extends, as a gain in the lowest frequency per volume, and it is worth having. Under uniform pressure the compliance ribs already take 98% of the frequency gain. Under a point load near one edge they take 3.8% of it, while the frequency ribs take 42%, and those frequency ribs leave the compliance essentially unchanged (1.005×).
6. A goal reads as an optional target on the request, absent unless set: the lowest frequency above N Hz, or the buckling load factor above N on a named pre-stress. The panel grows a number box that stays blank. What N is, and whether compliance remains beside it, is the owner's call. No field is added here.

## How the parts were built

All of these are synthetic. No company geometry.

- **Simply supported rectangle**, 200 × 100 × 1. Holds match the existing plate tests: ux, uy, uz held on the whole boundary, θx held on the edges of constant x, θy held on the edges of constant y, θz free. Closed form ω_mn = π² ((m/a)² + (n/b)²) √(D/ρh), modes (1,1), (2,1), (3,1), (1,2).
- **Simply supported square**, 100 × 100 × 1, uniaxial compression of 1 N/mm along x. Bending holds as above. ux held only on x = 0, uy held only at the origin, so Poisson can expand. Reference N_cr = 4π²D/b² = 0.723048 N/mm.
- **Clamped square**, 100 × 100 × 1, all six dofs held on the boundary. Leissa, *Vibration of Plates*, NASA SP-160 (1969): λ₁ = ω a² √(ρh/D) = 35.99.
- **Beam**, 200 mm, 8 elements, section 8 × 2, simply supported for bending about both axes. Euler P_cr = π²EI/L² on the weaker axis.
- **Panel**, 120 × 70 × 2, borders clamped. The planner tests do not use a 120 × 70 panel; they use larger walls at a 5 mm pitch (a 300 × 120 is divided 60 × 24). The timing mesh is this panel at that pitch, 24 × 14. The ranking mesh is 12 × 7, so each candidate is an exact eigen solve. Ribs are rectangular, 1.2 mm wide and 6 mm tall, one per column, full span, so equal count means equal volume (504 mm³ each). The probe does not apply the planner's 15 mm minimum spacing.

The eigen solve is faer's `partial_eigen` on the operator y = K⁻¹ S x. K is the solver's own upper triangle, factored with the same LDLᵀ the static solve uses. For vibration S is the mass and the eigenvalue is 1/ω². For buckling S is −Kg of the reference load and the eigenvalue is 1/λ. The number reported is the Rayleigh quotient vᵀKv / vᵀSv, after the converged vectors are sorted by 1/λ descending. Membrane dofs carry no mass and no plate Kg, so their eigenvalues are the small ones and drop out of a largest-magnitude solve. Every reported mode has more than 99% of its free-dof amplitude in uz.

## 1. Mass [probe]

Consistent mass uses the linear triangle: ∫ L_i L_j dA = A (1+δ_ij)/12, times ρ t, on ux, uy and uz. Lumped mass puts ρ t A/3 on each corner. Rotary inertia, when it is on, is ρ t³/12 per unit area, lumped to the corners.

Simply supported 200 × 100 × 1. Closed form ω₁₁ = 527.975, ω₂₁ = 844.760, ω₃₁ = 1372.74, ω₁₂ = 1795.12 rad/s.

| Mass | Mesh | ω₁₁ | error | ω₂₁ | error | ω₃₁ | error | ω₁₂ | error |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Consistent | 8×4 | 555.759 | +5.262% | 908.365 | +7.529% | 1544.34 | +12.501% | 2152.91 | +19.932% |
| Consistent | 16×8 | 534.855 | +1.303% | 860.611 | +1.876% | 1416.43 | +3.183% | 1884.54 | +4.982% |
| Consistent | 32×16 | 529.685 | +0.324% | 848.694 | +0.466% | 1383.61 | +0.792% | 1817.27 | +1.234% |
| Lumped | 32×16 | 527.564 | −0.078% | 843.270 | −0.176% | 1369.28 | −0.251% | 1792.66 | −0.137% |

The finest consistent mesh is inside 2% on all four modes. The error falls by about four each time the element size is halved, which is the DKT rate the static plate tests already show: the element is slightly stiff, so the frequencies come down from above. Lumped mass at the same mesh is closer to the closed form, by a cancellation. The two ω₁ differ by 0.40%. Ship the consistent mass. It is the mass of the shape functions, and the cancellation that flatters the lumped column will not survive a finer mesh or a rib.

Drilling and web rotation, on the 16×8 plate and on one 2 × 8 rib across a clamped 120 × 70 at 12 × 7:

| Mass | ω₁, rad/s | against the row's reference |
|---|---:|---:|
| Consistent, no rotary | 534.855 | +1.303% vs closed form |
| Lumped, no rotary | 526.360 | −0.306% vs closed form |
| Physical rotary on θx, θy, θz | 534.826 | 0.005% below the consistent row |
| Drilling mass × 10⁶ physical | 303.822 | −42.5%, and the mode is not bending (uz share 0) |
| Rib, shell mass only | 6676.50 | the reference for the rows below |
| Rib translation, ψ rotary 0 | 6640.57 | −0.538% |
| Rib translation + physical ψ | 6640.57 | same printed value |
| Rib translation + ψ × 10⁴ | 2402.88 | −64.0% |

The drilling dof gets no mass. A physical ρ t³/12 on θz is invisible to the lowest mode, and a huge one invents a drilling mode that the largest-magnitude solve then returns first. ψ gets the inertia that the rigid offset already produces when the rib's translational mass is transformed into the shell dofs (the same map the stiffness uses). An extra ρ I L on ψ changes nothing at six figures. The rib's own mass should be included: it moved this mode by half a percent, which is the same size as the discretisation error.

## 2. Geometric stiffness [probe]

Plate Kg is ∫ βᵀ N β dA on the nine DKT bending dofs, with β taken from the same slope interpolation as the element stiffness and N constant from the CST membrane strain. N is tension-positive, so compression makes Kg negative. The integral is degree 4; the probe uses the 7-point Dunavant rule. Each triangle is rotated into its own frame, because the second triangle of a rectangle cell does not have its first edge along x.

| Mesh | Plate Kg, N/mm | error vs 0.723048 | Plate + membrane Kg | Mean Nxx | Mean Nyy |
|---|---:|---:|---:|---:|---:|
| 8×8 | 0.720759 | −0.317% | 0.720759 | −1.014 | +0.014 |
| 16×16 | 0.722563 | −0.067% | 0.722563 | −1.004 | +0.004 |
| 32×32 | 0.722954 | −0.013% | 0.722954 | −1.001 | +0.001 |

The pre-stress is the uniaxial compression asked for: Nxx → −1, Nyy → 0. The membrane geometric stiffness, ∫ ∇uᵀ N ∇u dA on the in-plane dofs, does not move the lowest plate mode. The plate term is the one a panel buckling goal needs.

The beam is a separate check, eight Timoshenko elements, geometric stiffness the cubic Hermitian form at unit tension (P/30L), with the θy = −dw/dx sign the elastic beam already uses. Compression is a positive eigenvalue of K φ = P Kg φ.

| Case | P, N | Reference | error |
|---|---:|---:|---:|
| Weak-axis Euler, 8 elements | 2.63131 | 2.63190 | −0.022% |

The next eigenvalue is 10.52 N, the strong axis. Beam geometric stiffness can wait until a goal cares about a rib buckling on its own. A panel under in-plane load does not need it for the plate mode.

## 3. The eigen solver [read] [probe]

faer 0.24.4 is already a dependency, with `sparse-linalg`. That feature factors and solves. It does not solve a sparse generalized eigenproblem. `faer::matrix_free::eigen::partial_eigen` does: Krylov–Schur, matrix-free, eigenvalues of largest magnitude, and it is not behind a feature flag. `partial_self_adjoint_eigen` is the wrong call. K⁻¹M is self-adjoint in the M inner product, and that routine assumes the Euclidean one.

The probe asks for the requested count plus four, subspace dimension 24 to 48, 60 restarts, tolerance 10⁻⁹, one thread. Dense `generalized_eigen` is used only for the 54-dof beam.

There is no 120 × 70 panel in the planner tests. This one is that size at their 5 mm pitch.

| Solve | Mesh | Free dofs | Time |
|---|---|---:|---:|
| Static, factor + solve | 120×70, 24×14 | 1794 | 0.002 s (factor 0.001, solve < 0.001) |
| Lowest 3 modes | same | 1794 | 0.009 s |
| Static | square 32×32, buckling | 6240 | 0.010 s |
| Lowest buckling mode | same | 6240 | 0.151 s |
| Lowest 4 frequencies | rectangle 32×16 | 2978 | 0.023 s |

On the named panel the eigen solve is about four times one static solve. At 6240 dofs it is about fifteen times. Both are fractions of a second. Writing a Lanczos or a LOBPCG of our own is not the build. The static factor is reused as the operator; the extra cost is the Krylov iteration.

## 4. A repeated pair [probe]

Simply supported square, n = 12. Modes (2,1) and (1,2) are analytically equal. The mesh splits them: ω₂ = 2153.17, ω₃ = 2168.58, a gap of 0.72%. A rib along y = a/2, 1.2 × 6, lies on the node line of one of them.

The solver's two vectors are an arbitrary basis of that subspace. Their first-order scores 2E / (φᵀMφ), and the scores of the positive-quadrant mixtures, run from 2.97×10⁷ to 5.90×10⁷. The eigenvalues of the projected 2×2, which do not depend on the basis, are 4.68×10⁵ and 5.90×10⁷. Ratio 126. The vector the solver happened to return scores this rib 63× above the direction that remains the lower mode.

After the rib is actually inserted, the lower of the pair moves from 2153 to 2245 rad/s (+4.3%) and the other from 2169 to 3671 (+69%). The first-order bound 4.68×10⁵ matches the realized Δω² of the lower mode (4.03×10⁵) to 16%. The large eigenvalue is a linear estimate of a change that saturates.

The sum of the cluster is 5.95×10⁷, which is the large eigenvalue. Summing would treat a node-line rib as if it had stiffened both modes. The score for "raise the lowest" is the smaller eigenvalue of the projected cluster. The shortlist still re-solves, as it does for compliance today. The 2×2 is what the cheap estimate has to use, so a node-line rib is not ranked as a good one.

The same pair shows up on the clamped square, where the planner's borders actually are. At 32×32, λ₂ = 73.552 and λ₃ = 73.699, 0.20% apart. Leissa's repeated value is 73.41.

## 5. Does the greedy score extend? [probe]

Today's score is the drop in compliance per volume, with a first-order estimate and a shortlist of 8 solved exactly (`select.rs`). The probe ranks a pool of 11 equal ribs by the same greedy step, twice: drop in compliance, and rise in the lowest frequency. Two ribs, so 1008 mm³ either way. The search itself uses shell mass only. Every candidate has the same volume, so per-volume and absolute gain rank the same, and the finished designs are remeasured with the rib's translational mass and a physical ψ inertia.

Clamped 120 × 70 × 2, divided 12 × 7. Bare frequency 723.61 Hz.

| Load | Design | Columns | C, N·mm | Stiffness | f, Hz | with rib mass |
|---|---|---|---:|---:|---:|---:|
| Pressure 0.001 MPa | bare | | 0.11126 | | 723.61 | |
| Pressure | compliance | 6, 8 | 0.04993 | 2.228× | 1020.27 (+41.00%) | 1011.09 |
| Pressure | frequency | 6, 7 | 0.05274 | 2.110× | 1025.04 (+41.66%) | 1017.29 |
| Point load −10 N near (15, 35) | bare | | 0.49914 | | 723.61 | |
| Point load | compliance | 1, 2 | 0.25909 | 1.927× | 751.10 (+3.80%) | 750.37 |
| Point load | frequency | 6, 7 | 0.49669 | 1.005× | 1025.04 (+41.66%) | 1017.29 |

Under pressure the first mode and the load have the same shape, and the compliance ribs take 98% of the frequency gain. Under the point load they do not: +3.8% against +41.7%, and the frequency ribs buy almost no compliance. Rib mass costs under 1% of the finished frequency. It belongs in the objective, and it does not change this ranking.

Columns 6 and 7 are 10 mm apart, and columns 1 and 2 are 10 mm apart. The planner's default minimum spacing is 15 mm, which the probe did not apply. The pressure result survives that rule: the compliance pair is columns 6 and 8, 20 mm apart, and it is the pair that already holds 98% of the frequency gain.

Today's `plan_ribs` on the same panel, `Goal::Budget` of 1008 mm³, baselines off, one worker, placed one rib, used 504.2 mm³, and raised the stiffness 1.778× (compliance 0.11112 to 0.06249). A second rib of this section is another 504 mm³, which does not fit the remainder. That run is context. The equal-volume comparison is the table above.

## 6. How a goal reads [read]

A sketch, only. Defaults stay with the owner. Nothing in `ribs_plan` or the panel changes in this study.

The request gains an optional target, unset unless the caller sets it, so a request from today is unchanged:

- `frequency: { aboveHz }` — grow while the lower bound of the lowest cluster is under that frequency.
- `buckling: { above, on }` — grow while the load factor on the named load case, used as pre-stress, is under that factor. `on` has to name a case, because a pressure that bends the panel does not buckle it.

The score is the rise in that bound per volume. The cluster bound of §4 is the estimate; the shortlist re-solves, as it does now. A budget, if one is set, still stops the growth. Whether a frequency target and a compliance target can both be live, and what happens when the target is unreachable, is the owner's call.

The panel gains a blank number box for each, in the place the budget already occupies. An empty box sends no target.

## Build order and size

Vibration, then buckling. The study does not reverse the handover.

Vibration is the first slice: the consistent mass of §1, including the rib's translational mass and no extra drilling or ψ inertia; `partial_eigen` on K⁻¹M; the cluster bound inside the estimate the greedy step already makes; an optional frequency target. The plate tests pass at the 2% bar, and the score is the part that is wrong if it is skipped.

Buckling is the second slice, on the same operator with S = −Kg. The new code is the plate geometric stiffness of §2, recovered from a static solve the planner already runs, plus an optional load-factor target and a way to name the pre-stress. Membrane Kg is dead weight for this mode. Beam Kg is proven and can wait.

The package stays the handover's L. Each slice is a solver addition plus a score change plus a goal the owner still has to word. No new defaults, and no tool field, until that wording exists.

## What was not answered

- A ribbed panel against a solid modal model. The in-repo solid study is static Tet10 only. CalculiX is the handover's reserve for a dev-machine cross-check: `ccx` is not installed here, and it is not in apt. Nothing was bundled, and nothing was added to CI. The textbook plates are the reference that was met.
- Clamped-plate buckling (the published coefficient is near 10.1). The clamped case that was run is Leissa's frequency, because that is the boundary the planner uses. λ₁ at 32×32 is 36.019, +0.080% on 35.99. The coarser meshes are +1.398% (8×8) and +0.357% (16×16).
- Whether a hand-written LOBPCG would beat faer's Arnoldi. The times in §3 are small enough that it is not the build.
