# Loft

Loft blends two or more closed sections in the order they are picked. The open sketch is the first section. A click on a pinned sketch card adds that sketch. **Ruled** (R) makes a straight blend. Leave it off for a smooth blend. Sections in one plane are refused.

Finish a sketch before starting the next one. **Sketch** on the card, then a plane, starts a new sketch only when none is being edited.

To raise a section before any solid exists, type an **Offset** on the "Sketch on" card and then pick XY, XZ, or YZ. The offset moves that plane along its normal. XY offset is +Z. The Workplane button is for a plane on a solid that already exists, so these examples use Offset instead.

A circle is Draw, then Circle. Click the centre and type the diameter.

## A square-to-round duct

A 40 mm square on the bed, a Ø22 mm circle 50 mm above it, ruled.

**Sketch**, XY plane, **Rectangle**. Hold Ctrl on the first click so the rectangle grows from its centre, click the origin, and type width 40 and height 40.

![The 40 mm square, centred on the bed. Horizontal and vertical are already on its sides.](../screenshots/tutorials/loft/duct-01-square.png)

**Finish sketch**. The card keeps it as Sketch 1. **Sketch** again, type **50** in Offset, then click **XY plane**. The new sketch is 50 mm up.

![Offset 50, then XY. That plane is 50 mm above the bed.](../screenshots/tutorials/loft/duct-02-offset.png)

**Draw**, then **Circle**. Click the origin and type diameter **22**.

![Circle is the first item in Draw.](../screenshots/tutorials/loft/duct-03-circle-tool.png)

![Ø22 mm on the raised plane. Sketch 1, the square, is pinned underneath.](../screenshots/tutorials/loft/duct-04-circle.png)

Click **Loft** (Shift+L). The open circle is section 1. Click the **Sketch 1** card to add the square. Click **Ruled**. Look around (O) and drag an empty part of the view to see the two sections apart. The ghost is the straight blend.

![Ruled loft, two sections. The circle is 50 mm above the square.](../screenshots/tutorials/loft/duct-05-loft.png)

**Apply**. History reads "Loft through 2 sections, ruled". The adapter is 40 × 40 mm at the base and 50 mm tall.

![The duct adapter.](../screenshots/tutorials/loft/duct-06-result.png)

## A bottle from three sections

Three circles on the same axis, smooth. Draw the top first so the open sketch at the end can be the body, and the pinned cards add the shoulder and the neck in that order.

1. **Sketch**, Offset **78**, XY plane, Circle at the origin, diameter **16**. Finish. This is the neck, Sketch 1.
2. **Sketch**, Offset **46**, XY plane, Circle, diameter **34**. Finish. This is the shoulder, Sketch 2.
3. **Sketch**, XY plane with offset 0, Circle, diameter **42**. Leave this one open. It is the body and becomes section 1.

![Offset 78 mm for the neck.](../screenshots/tutorials/loft/bottle-01-offset.png)

![The neck, Ø16 mm.](../screenshots/tutorials/loft/bottle-02-neck.png)

![The shoulder, Ø34 mm, with Sketch 1 pinned.](../screenshots/tutorials/loft/bottle-03-shoulder.png)

![The body, Ø42 mm, on the bed. Sketch 1 and Sketch 2 are ready to pick.](../screenshots/tutorials/loft/bottle-04-body.png)

**Loft**. Click **Sketch 2** (shoulder), then **Sketch 1** (neck). Leave Ruled off, so the button reads Smooth. The order is body, shoulder, neck. Look around and drag to see the three rings.

![Three sections, smooth. The open body is first, then the shoulder, then the neck.](../screenshots/tutorials/loft/bottle-05-loft.png)

**Apply**. History reads "Loft through 3 sections". The bottle is 78 mm tall and about Ø42 mm at the base.

![The bottle. The shoulder is the smooth step between the body and the neck.](../screenshots/tutorials/loft/bottle-06-result.png)

## A funnel shifted sideways

The small end is not above the middle of the large end. Offset only moves a plane along its normal, so the sideways shift is where you place the circle.

1. **Sketch**, Offset **42**, XY plane. Circle at U = 18, V = 0, diameter **14**. Finish. Sketch 1 is the small end, 18 mm off the origin.
2. **Sketch**, XY plane, offset 0. Circle at the origin, diameter **46**. Leave it open.

![Offset 42 for the small end.](../screenshots/tutorials/loft/funnel-01-offset.png)

![Ø14 mm, drawn 18 mm to the right of the origin on the raised plane.](../screenshots/tutorials/loft/funnel-02-small.png)

![Ø46 mm on the bed. Sketch 1 is the small circle.](../screenshots/tutorials/loft/funnel-03-large.png)

**Loft**, click **Sketch 1**, leave it smooth. Look around. The ghost leans because the upper circle is not on the same centre.

![The two circles, one of them shifted. Smooth blend.](../screenshots/tutorials/loft/funnel-04-loft.png)

**Apply**. The funnel is 42 mm tall and leans toward the shifted end.

![The finished funnel.](../screenshots/tutorials/loft/funnel-05-result.png)
