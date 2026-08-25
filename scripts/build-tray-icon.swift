import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 2 else {
    fputs("usage: build-tray-icon.swift <output-directory>\n", stderr)
    exit(2)
}

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)

for (filename, size) in [("trayIconTemplate.png", 16), ("trayIconTemplate@2x.png", 32)] {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: size * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fputs("could not create CGContext\n", stderr)
        exit(1)
    }

    context.clear(CGRect(x: 0, y: 0, width: size, height: size))
    context.scaleBy(x: CGFloat(size) / 18, y: CGFloat(size) / 18)
    context.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.setLineWidth(1.8)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    func strokeDiamond(_ points: [CGPoint]) {
        context.move(to: points[0])
        for point in points.dropFirst() {
            context.addLine(to: point)
        }
        context.closePath()
        context.strokePath()
    }

    strokeDiamond([CGPoint(x: 3.2, y: 9), CGPoint(x: 6.8, y: 5.4), CGPoint(x: 10.4, y: 9), CGPoint(x: 6.8, y: 12.6)])
    strokeDiamond([CGPoint(x: 7.6, y: 9), CGPoint(x: 11.2, y: 5.4), CGPoint(x: 14.8, y: 9), CGPoint(x: 11.2, y: 12.6)])

    guard let image = context.makeImage() else {
        fputs("could not create tray image\n", stderr)
        exit(1)
    }
    let destinationURL = outputDirectory.appendingPathComponent(filename)
    guard let destination = CGImageDestinationCreateWithURL(destinationURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fputs("could not create PNG destination\n", stderr)
        exit(1)
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fputs("could not write PNG\n", stderr)
        exit(1)
    }
}
