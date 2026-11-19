#pragma once

class Arduino_GFX;
struct KeyringScreen;

void drawR26Display(Arduino_GFX &panel, const KeyringScreen &screen, const KeyringScreen *previous);
