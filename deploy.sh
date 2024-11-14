#!/bin/bash
ssh aws 'cd ~/toyos.dev/; git pull origin master; sudo systemctl restart toyos'