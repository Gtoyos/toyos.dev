#!/bin/bash
ssh aws 'cd ~/toyos.dev/; git pull origin master; git submodule update --init --remote distcomp-viz; sudo systemctl restart toyos'
