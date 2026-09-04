#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { buildStack } from "../lib/stack";

const app = new cdk.App();
buildStack(app);
