#!/bin/bash
ssh ubuntu@srv 'cd toyos.dev/; git pull origin master; sudo systemctl restart toyos'