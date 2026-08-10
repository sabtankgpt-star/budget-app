from PIL import Image, ImageDraw

SIZE = 512
img = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
draw = ImageDraw.Draw(img)

bg_color = (13, 13, 15, 255)
draw.rounded_rectangle([0,0,SIZE,SIZE], radius=110, fill=bg_color)

cx, cy = SIZE//2, SIZE//2
r = 170
orange = (245, 158, 11, 255)
draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill=orange)

bar_color = (13,13,15,255)
bar_width = 46
gap = 26
heights = [70, 110, 150]
total_width = bar_width*3 + gap*2
start_x = cx - total_width//2
base_y = cy + 80
for i,h in enumerate(heights):
    x0 = start_x + i*(bar_width+gap)
    x1 = x0 + bar_width
    y1 = base_y
    y0 = base_y - h
    draw.rounded_rectangle([x0,y0,x1,y1], radius=14, fill=bar_color)

line_pts = [(start_x+bar_width//2, base_y-heights[0]-18),
            (start_x+bar_width+gap+bar_width//2, base_y-heights[1]-18),
            (start_x+2*(bar_width+gap)+bar_width//2, base_y-heights[2]-18)]
draw.line(line_pts, fill=bar_color, width=10, joint="curve")
for pt in line_pts:
    draw.ellipse([pt[0]-11, pt[1]-11, pt[0]+11, pt[1]+11], fill=bar_color)

img.save("public/icon-512.png")
img.resize((192,192), Image.LANCZOS).save("public/icon-192.png")
img.resize((180,180), Image.LANCZOS).save("public/apple-touch-icon.png")
print("icons created in public/")
