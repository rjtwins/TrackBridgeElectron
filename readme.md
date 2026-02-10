# Viture WebHid Bridge

Electron app using [viture-webxr-extension](https://github.com/bfvogel/viture-webxr-extension) to bridge Viture head tracking data to UDP receivers (Open Track/FaceTrackNoIr).

Raw pitch, yaw and roll are provided as follows:

```
byte 0–7   : x     (float64, little-endian)
byte 8–15  : y     (float64, little-endian)
byte 16–23 : z     (float64, little-endian)
byte 24–31 : yaw   (float64, little-endian)
byte 32–39 : pitch (float64, little-endian)
byte 40–47 : roll  (float64, little-endian)
```

## Usage


Run using npm
```bash
npm install
npm run start
```
Build release artifacts:
```
npm run build
```
Then install using "VitureHidBridge Setup 1.0.0.exe"

Will broadcast on port 5550.

## Compatability
Should be compatible with:

```
Vendor Id: 0x35ca
Name:               Product Ids:
Viture One          [0x1011, 0x1013, 0x1017]
Viture One Lite     [0x1015, 0x101b]
Viture Pro          [0x1019, 0x101d]
Viture Luma Pro     [0x1121, 0x1141]
Viture Luma         [0x1131]
```

See viture-hid.js.


## Credits
[viture-webxr-extension](https://github.com/bfvogel/viture-webxr-extension)

## License
[MIT](https://choosealicense.com/licenses/mit/)