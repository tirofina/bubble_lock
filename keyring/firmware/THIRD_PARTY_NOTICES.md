# Peripheral source references and notices

Arduino_GFX is a pinned dependency, not vendored. Its upstream
[license.txt](https://github.com/moononournation/Arduino_GFX/blob/3cc08c4e9ab6d85807e49b657d73fae10871616e/license.txt)
contains the BSD license and Adafruit Industries copyright. Retain the dependency
license and applicable upstream notices when distributing source or firmware.

JD9853 command order, RGB565 and MADCTL mapping were informed by the original
author's [jd9853-rs](https://github.com/drindr/jd9853-rs/tree/186e52d3c264c899d8910a63297e48a1d2a8d516).
The C++ transport/graphics integration is written for this project. No vendor
initialization table was copied. The consulted repository declares MIT OR
Apache-2.0; its LICENSE contains:

MIT License

Copyright (c) 2026 Drin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## r26 LCD 글자 이미지

r26 UI에는 The Barlow Project Authors의 Barlow Semi Condensed 글꼴을 화면 크기로 렌더링한 글자 이미지가 들어간다. 생성 스크립트는 `tools/make_r26_text_masks.py`다. [원본 글꼴과 SIL Open Font License 1.1](https://github.com/google/fonts/tree/5bd87dfc525c8a0d1d8529d3684716e00c3fc59a/ofl/barlowsemicondensed)
