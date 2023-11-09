#!/bin/sh
git clone git@github.com:capstone-engine/capstone.git
cd capstone
emmake make libcapstone.a OS=linux CAPSTONE_ARCHS=m68k
cd cstool
emmake make OS=linux CAPSTONE_ARCHS=m68k
cp cstool.wasm ../../
cp cstool ../../
