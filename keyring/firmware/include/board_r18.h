#pragma once
#include <stdint.h>

// Source: r17/common_pcb/working_data/GPIO_pinmap.csv and r18 native PCB U1 nets.
// Older r17 root pin maps and BOM prose contain superseded GPIO assignments.
namespace board {
constexpr char Revision[] = "r18-hand-solder";
constexpr int AuxEnable = 4;
constexpr int Confirm = 6;
constexpr int Panic = 7;
constexpr int Motor = 3;
constexpr int AmpMute = 16;       // HIGH mutes through Q4.
constexpr int AccelInterrupt = 17;
constexpr int LcdCs = 18;
constexpr int LcdDc = 8;
constexpr int LcdMosi = 38;
constexpr int LcdSck = 39;
constexpr int LcdBacklight = 2;   // HIGH is OFF through Q3.
constexpr int LcdReset = 43;      // UART_TX -> R69 -> LCD_RST; no UART0 logs.
constexpr int SdCs = 10;
constexpr int SdMiso = 11;
constexpr int I2cSda = 14;
constexpr int I2cScl = 21;
constexpr int I2sLrclk = 40;
constexpr int I2sBclk = 41;
constexpr int I2sDout = 42;
constexpr int HeadphoneMclk = 13;
constexpr int UsbEn1 = 47;
constexpr int UsbEn2 = 9;
constexpr int MainFaultN = 1;
constexpr uint8_t FuelAddress = 0x36;
constexpr uint8_t AccelAddress = 0x19;
constexpr uint32_t MotorMaxOnMs = 1000;
constexpr uint32_t DebounceMs = 35;
constexpr uint32_t ObserveMs = 2000;
// IO5/12/15/48 are NC. GPIO35/36/37 belong to octal PSRAM.
}
